#![cfg(test)]
use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Map, String, Vec,
};

const USDC: i128 = 10_000_000; // 1 USDC with 7 decimals
const YEAR: u64 = 365 * DAY;
const DEPOSIT: i128 = 1_000 * USDC;

/// Fake Blend pool: pulls funds with the allowance on Supply, returns everything it holds
/// on Withdraw, and can be switched to "illiquid" (withdrawals fail, like a fully borrowed pool).
#[contract]
pub struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn set_illiquid(env: Env, v: bool) {
        env.storage().instance().set(&symbol_short!("illiq"), &v);
    }

    /// Next withdrawals only return this amount (simulates a partial withdrawal).
    pub fn set_partial(env: Env, amount: i128) {
        env.storage().instance().set(&symbol_short!("partial"), &amount);
    }

    pub fn submit_with_allowance(
        env: Env,
        _from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions {
        let me = env.current_contract_address();
        let illiquid: bool = env.storage().instance().get(&symbol_short!("illiq")).unwrap_or(false);
        for r in requests.iter() {
            let t = TokenClient::new(&env, &r.address);
            if r.request_type == REQ_SUPPLY {
                t.transfer_from(&me, &spender, &me, &r.amount);
            } else {
                assert!(!illiquid, "pool illiquid");
                let all = t.balance(&me);
                let partial: i128 = env.storage().instance().get(&symbol_short!("partial")).unwrap_or(0);
                let out = if partial > 0 && partial < all { partial } else { all };
                t.transfer(&me, &to, &out);
                let left = all - out;
                let mut supply = Map::new(&env);
                if left > 0 {
                    supply.set(3u32, left); // our remaining bTokens (1:1 in the mock)
                }
                return Positions { collateral: Map::new(&env), liabilities: Map::new(&env), supply };
            }
        }
        Positions { collateral: Map::new(&env), liabilities: Map::new(&env), supply: Map::new(&env) }
    }
}

/// Fake DeFindex vault: `deposit` pulls the tokens from `from` (a nested transfer the caller
/// must authorize), mints shares 1:1; `withdraw` burns shares and pays out everything it
/// holds pro rata (so pre-minted tokens act as yield). Can be switched to "illiquid".
#[contract]
pub struct MockVault;

#[contractimpl]
impl MockVault {
    pub fn init(env: Env, token: Address) {
        env.storage().instance().set(&symbol_short!("token"), &token);
    }

    pub fn set_illiquid(env: Env, v: bool) {
        env.storage().instance().set(&symbol_short!("illiq"), &v);
    }

    pub fn deposit(
        env: Env,
        amounts_desired: Vec<i128>,
        _amounts_min: Vec<i128>,
        from: Address,
        _invest: bool,
    ) -> (Vec<i128>, i128) {
        from.require_auth();
        let token: Address = env.storage().instance().get(&symbol_short!("token")).unwrap();
        let amount = amounts_desired.get(0).unwrap();
        TokenClient::new(&env, &token).transfer(&from, &env.current_contract_address(), &amount);
        let bal: i128 = env.storage().persistent().get(&from).unwrap_or(0);
        env.storage().persistent().set(&from, &(bal + amount));
        let total: i128 = env.storage().instance().get(&symbol_short!("total")).unwrap_or(0);
        env.storage().instance().set(&symbol_short!("total"), &(total + amount));
        (amounts_desired, amount)
    }

    pub fn withdraw(env: Env, shares: i128, _min_out: Vec<i128>, from: Address) -> Vec<i128> {
        from.require_auth();
        let illiquid: bool = env.storage().instance().get(&symbol_short!("illiq")).unwrap_or(false);
        assert!(!illiquid, "vault illiquid");
        let token: Address = env.storage().instance().get(&symbol_short!("token")).unwrap();
        let t = TokenClient::new(&env, &token);
        let me = env.current_contract_address();
        let total: i128 = env.storage().instance().get(&symbol_short!("total")).unwrap();
        let out = t.balance(&me) * shares / total;
        t.transfer(&me, &from, &out);
        let bal: i128 = env.storage().persistent().get(&from).unwrap_or(0);
        env.storage().persistent().set(&from, &(bal - shares));
        env.storage().instance().set(&symbol_short!("total"), &(total - shares));
        vec![&env, out]
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&id).unwrap_or(0)
    }
}

struct Setup<'a> {
    env: Env,
    c: RentalDepositClient<'a>,
    t: TokenClient<'a>,
    pool: MockPoolClient<'a>,
    vault: MockVaultClient<'a>,
    token: Address,
    tenant: Address,
    landlord: Address,
    arbiter: Address,
    bps: u32,
    dfx: u32,
    ly: u32,
    end: u64,
}

struct Parties {
    env: Env,
    token: Address,
    pool: Address,
    vault: Address,
    tenant: Address,
    landlord: Address,
    arbiter: Address,
}

fn parties() -> Parties {
    let env = Env::default();
    env.mock_all_auths(); // skip real signatures (auth is checked separately below)
    env.ledger().set_timestamp(1_000_000);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address(); // fake USDC
    let sac = StellarAssetClient::new(&env, &token);
    let tenant = Address::generate(&env);
    let landlord = Address::generate(&env);
    let arbiter = Address::generate(&env);
    sac.mint(&tenant, &DEPOSIT);
    let pool = env.register(MockPool, ());
    sac.mint(&pool, &(7 * USDC)); // simulated yield sitting in the pool
    let vault = env.register(MockVault, ());
    MockVaultClient::new(&env, &vault).init(&token);
    sac.mint(&vault, &(3 * USDC)); // simulated yield inside the DeFindex vault
    Parties { env, token, pool, vault, tenant, landlord, arbiter }
}

/// Landlord creates the agreement (deploy + constructor). Blend only.
fn setup<'a>(bps: u32) -> Setup<'a> {
    setup_split(bps, 0)
}

/// Same, routing `dfx` (bps) of the invested share to the DeFindex vault.
fn setup_split<'a>(bps: u32, dfx: u32) -> Setup<'a> {
    setup_full(bps, dfx, 0)
}

/// Same, with `ly` (bps) of the yield going to the landlord.
fn setup_full<'a>(bps: u32, dfx: u32, ly: u32) -> Setup<'a> {
    let p = parties();
    let end = p.env.ledger().timestamp() + YEAR;
    let id = p.env.register(
        RentalDeposit,
        (
            p.landlord.clone(),
            p.tenant.clone(),
            p.arbiter.clone(),
            p.token.clone(),
            p.pool.clone(),
            p.vault.clone(),
            DEPOSIT,
            ly,
            end,
        ),
    );
    let c = RentalDepositClient::new(&p.env, &id);
    let t = TokenClient::new(&p.env, &p.token);
    let pool = MockPoolClient::new(&p.env, &p.pool);
    let vault = MockVaultClient::new(&p.env, &p.vault);
    Setup {
        env: p.env,
        c,
        t,
        pool,
        vault,
        token: p.token,
        tenant: p.tenant,
        landlord: p.landlord,
        arbiter: p.arbiter,
        bps,
        dfx,
        ly,
        end,
    }
}

/// Tenant accepts the exact terms by depositing.
fn fund(s: &Setup) {
    s.c.fund(
        &s.landlord, &s.arbiter, &s.token, &s.pool.address, &s.vault.address, &DEPOSIT, &s.bps, &s.dfx,
        &s.ly, &s.end,
    );
}

fn funded<'a>(bps: u32) -> Setup<'a> {
    let s = setup(bps);
    fund(&s);
    s
}

fn propose(s: &Setup, amount: i128) {
    s.c.propose_deduction(&amount, &String::from_str(&s.env, "ipfs://photos"));
}

fn jump_to(s: &Setup, ts: u64) {
    s.env.ledger().set_timestamp(ts);
}

// ---------- happy path ----------

#[test]
fn happy_path_with_yield() {
    let s = setup(7_000);
    assert_eq!(s.c.get_deposit().state, State::Offered);
    fund(&s);
    assert_eq!(s.env.auths()[0].0, s.tenant);
    assert_eq!(s.t.balance(&s.pool.address), 707 * USDC); // 700 supplied + 7 yield
    assert!(s.c.get_deposit().in_blend);

    propose(&s, 120 * USDC);
    assert_eq!(s.env.auths()[0].0, s.landlord);
    s.c.accept_and_release();
    assert_eq!(s.env.auths()[0].0, s.tenant);

    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 887 * USDC); // 880 + 7 yield
    let d = s.c.get_deposit();
    assert_eq!(d.state, State::Closed);
    assert_eq!(d.paid_landlord, 120 * USDC);
    assert_eq!(d.paid_tenant, 887 * USDC);
    assert!(!d.in_blend);
}

#[test]
fn zero_invest_skips_blend() {
    let s = funded(0);
    propose(&s, 120 * USDC);
    s.c.accept_and_release();
    assert_eq!(s.t.balance(&s.tenant), 880 * USDC);
    assert_eq!(s.t.balance(&s.pool.address), 7 * USDC); // pool untouched
}

// ---------- consent and auth ----------

#[test]
#[should_panic(expected = "terms mismatch")]
fn tenant_signature_commits_to_the_terms() {
    let s = setup(7_000);
    // Tenant believes the arbiter is someone else: funding must fail
    let other = Address::generate(&s.env);
    s.c.fund(&s.landlord, &other, &s.token, &s.pool.address, &s.vault.address, &DEPOSIT, &s.bps, &s.dfx, &s.ly, &s.end);
}

#[test]
fn only_the_tenant_can_fund() {
    let s = setup(7_000);
    s.env.set_auths(&[]); // no signatures at all
    let r = s.c.try_fund(
        &s.landlord, &s.arbiter, &s.token, &s.pool.address, &s.vault.address, &DEPOSIT, &s.bps, &s.dfx,
        &s.ly, &s.end,
    );
    assert!(r.is_err());
}

#[test]
fn creating_an_agreement_needs_the_landlords_signature() {
    let p = parties();
    let end = p.env.ledger().timestamp() + YEAR;
    deploy_with(&p, &p.tenant, &p.arbiter, 7_000, end);
    let auths = p.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, p.landlord); // the constructor required the landlord's signature
}

#[test]
fn landlord_can_cancel_unfunded_offer() {
    let s = setup(7_000);
    s.c.cancel_offer();
    assert_eq!(s.c.get_deposit().state, State::Closed);
    assert_eq!(s.t.balance(&s.tenant), DEPOSIT); // nothing moved
}

#[test]
#[should_panic(expected = "wrong state")]
fn cannot_cancel_after_funding() {
    let s = funded(7_000);
    s.c.cancel_offer();
}

#[test]
#[should_panic(expected = "wrong state")]
fn cannot_fund_twice() {
    let s = funded(0);
    fund(&s);
}

// ---------- input checks (constructor) ----------

fn deploy_with(p: &Parties, tenant: &Address, arbiter: &Address, _bps: u32, end: u64) {
    p.env.register(
        RentalDeposit,
        (
            p.landlord.clone(),
            tenant.clone(),
            arbiter.clone(),
            p.token.clone(),
            p.pool.clone(),
            p.vault.clone(),
            DEPOSIT,
            0u32,
            end,
        ),
    );
}

#[test]
#[should_panic(expected = "invest share above 80%")]
fn cannot_invest_more_than_80_percent() {
    let s = setup(9_000); // the tenant asks for 90% when funding
    fund(&s);
}

#[test]
#[should_panic(expected = "tenant and landlord must differ")]
fn tenant_cannot_be_landlord() {
    let p = parties();
    let end = p.env.ledger().timestamp() + YEAR;
    deploy_with(&p, &p.landlord, &p.arbiter, 7_000, end);
}

#[test]
#[should_panic(expected = "arbiter must be neutral")]
fn arbiter_must_be_neutral() {
    let p = parties();
    let end = p.env.ledger().timestamp() + YEAR;
    deploy_with(&p, &p.tenant, &p.landlord, 7_000, end);
}

#[test]
#[should_panic(expected = "lease longer than 5 years")]
fn lease_end_is_bounded() {
    let p = parties();
    deploy_with(&p, &p.tenant, &p.arbiter, 7_000, u64::MAX - 1);
}

#[test]
#[should_panic(expected = "deduction out of range")]
fn deduction_cannot_exceed_deposit() {
    let s = funded(7_000);
    propose(&s, 1_001 * USDC);
}

#[test]
#[should_panic(expected = "evidence too long")]
fn evidence_is_bounded() {
    let s = funded(7_000);
    let long = "x".repeat(300);
    s.c.propose_deduction(&(10 * USDC), &String::from_str(&s.env, &long));
}

// ---------- the landlord can't force an early deduction ----------

#[test]
fn early_deduction_cannot_be_finalized_before_lease_end() {
    let s = funded(7_000);
    let t0 = s.env.ledger().timestamp();
    propose(&s, DEPOSIT); // day 0: landlord asks for everything
    jump_to(&s, t0 + 15 * DAY); // tenant silent for 15 days
    assert!(s.c.try_finalize_deduction().is_err()); // lease still running: blocked
    jump_to(&s, s.end + 13 * DAY);
    assert!(s.c.try_finalize_deduction().is_err()); // 14-day window counts from lease end
    jump_to(&s, s.end + 15 * DAY);
    s.c.finalize_deduction();
    assert_eq!(s.t.balance(&s.landlord), DEPOSIT);
}

#[test]
fn landlord_finalizes_if_tenant_silent() {
    let s = funded(7_000);
    jump_to(&s, s.end);
    propose(&s, 120 * USDC);
    jump_to(&s, s.end + 15 * DAY);
    s.c.finalize_deduction();
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 887 * USDC);
}

// ---------- disputes ----------

#[test]
#[should_panic(expected = "wrong state")]
fn dispute_blocks_release() {
    let s = funded(7_000);
    propose(&s, 120 * USDC);
    s.c.dispute();
    s.c.accept_and_release();
}

#[test]
fn arbiter_resolves_dispute() {
    let s = funded(7_000);
    propose(&s, 120 * USDC);
    s.c.dispute();
    s.c.resolve(&(50 * USDC));
    assert_eq!(s.env.auths()[0].0, s.arbiter);
    assert_eq!(s.t.balance(&s.landlord), 50 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 957 * USDC); // 950 + 7 yield
    assert_eq!(s.c.get_deposit().state, State::Closed);
}

#[test]
#[should_panic(expected = "deduction out of range")]
fn arbiter_cannot_award_more_than_asked() {
    let s = funded(7_000);
    propose(&s, 120 * USDC);
    s.c.dispute();
    s.c.resolve(&(121 * USDC));
}

#[test]
fn silent_arbiter_cannot_freeze_funds_forever() {
    let s = funded(7_000);
    jump_to(&s, s.end);
    propose(&s, 120 * USDC);
    s.c.dispute();
    let t0 = s.env.ledger().timestamp();
    jump_to(&s, t0 + 29 * DAY);
    assert!(s.c.try_settle_after_arbiter_timeout().is_err()); // arbiter still has time
    jump_to(&s, t0 + 31 * DAY);
    s.c.settle_after_arbiter_timeout();
    assert_eq!(s.t.balance(&s.tenant), 1_007 * USDC);
    assert_eq!(s.t.balance(&s.landlord), 0);
}

// ---------- liquidity: the buffer pays even if Blend is illiquid ----------

#[test]
fn illiquid_blend_buffer_pays_now_rest_later() {
    let s = funded(7_000); // 300 liquid, 700 in Blend
    propose(&s, 120 * USDC);
    s.pool.set_illiquid(&true);
    s.c.accept_and_release(); // must NOT revert

    // Landlord paid in full from the buffer; tenant gets the rest of the buffer now
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 180 * USDC);
    let d = s.c.get_deposit();
    assert_eq!(d.state, State::Settling);
    assert!(d.in_blend);

    // Still illiquid: claiming fails and changes nothing
    assert!(s.c.try_claim_remaining().is_err());

    // Liquidity is back: anyone can finish the settlement
    s.pool.set_illiquid(&false);
    s.c.claim_remaining();
    assert_eq!(s.t.balance(&s.tenant), 887 * USDC); // 180 + 700 + 7 yield
    let d = s.c.get_deposit();
    assert_eq!(d.state, State::Closed);
    assert_eq!(d.paid_tenant, 887 * USDC);
    assert_eq!(d.paid_landlord, 120 * USDC);
}

#[test]
fn illiquid_blend_big_deduction_landlord_first() {
    let s = funded(8_000); // 200 liquid, 800 in Blend
    propose(&s, 500 * USDC); // bigger than the buffer
    s.pool.set_illiquid(&true);
    s.c.accept_and_release();

    // Waterfall: the whole buffer goes to the landlord, the tenant waits
    assert_eq!(s.t.balance(&s.landlord), 200 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 0);
    assert_eq!(s.c.get_deposit().owed_landlord, 300 * USDC);

    s.pool.set_illiquid(&false);
    s.c.claim_remaining();
    assert_eq!(s.t.balance(&s.landlord), 500 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 507 * USDC); // 500 + 7 yield
}

// ---------- early unwind (liquidity control) ----------

#[test]
#[should_panic(expected = "unwind window not open")]
fn unwind_too_early() {
    let s = funded(7_000);
    s.c.unwind();
}

#[test]
fn unwind_in_last_30_days_then_settle_even_if_pool_illiquid() {
    let s = funded(7_000);
    jump_to(&s, s.end - 10 * DAY);
    s.c.unwind(); // anyone can call it
    assert_eq!(s.t.balance(&s.pool.address), 0);
    assert!(!s.c.get_deposit().in_blend);

    s.pool.set_illiquid(&true); // irrelevant now: funds already out
    propose(&s, 120 * USDC);
    s.c.accept_and_release();
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 887 * USDC);
    assert_eq!(s.c.get_deposit().state, State::Closed);
}

#[test]
#[should_panic(expected = "wrong state")]
fn cannot_unwind_before_funding() {
    let s = setup(7_000);
    s.c.unwind();
}

// ---------- timeouts (nobody can hold the deposit hostage) ----------

#[test]
fn tenant_refunded_if_landlord_never_claims() {
    let s = funded(7_000);
    jump_to(&s, s.end + 15 * DAY);
    s.c.claim_full_refund();
    assert_eq!(s.t.balance(&s.tenant), 1_007 * USDC);
    assert_eq!(s.t.balance(&s.landlord), 0);
}

#[test]
#[should_panic(expected = "too early")]
fn refund_not_before_response_window() {
    let s = funded(7_000);
    jump_to(&s, s.end + 13 * DAY);
    s.c.claim_full_refund();
}

#[test]
fn anyone_can_extend_ttl() {
    let s = funded(7_000);
    s.c.extend_ttl();
    assert_eq!(s.c.get_deposit().state, State::Funded);
}


#[test]
fn partial_withdrawal_never_closes_with_funds_left_in_blend() {
    let s = funded(7_000); // 300 liquid, 700 + 7 yield in the pool
    propose(&s, 120 * USDC);
    s.pool.set_partial(&(400 * USDC)); // Blend only returns 400 now
    s.c.accept_and_release();
    let d = s.c.get_deposit();
    assert_eq!(d.state, State::Settling); // not Closed: 307 still in Blend
    assert!(d.in_blend);
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 580 * USDC); // 300 + 400 - 120

    s.pool.set_partial(&0); // back to normal
    s.c.claim_remaining();
    assert_eq!(s.c.get_deposit().state, State::Closed);
    assert_eq!(s.t.balance(&s.tenant), 887 * USDC);
    assert_eq!(s.t.balance(&s.pool.address), 0);
}

#[test]
fn early_dispute_cannot_release_the_deposit_mid_lease() {
    let s = funded(7_000);
    let t0 = s.env.ledger().timestamp();
    propose(&s, 120 * USDC); // day 0
    s.c.dispute(); // tenant disputes right away, arbiter stays silent
    jump_to(&s, t0 + 31 * DAY);
    assert!(s.c.try_settle_after_arbiter_timeout().is_err()); // lease still running
    jump_to(&s, s.end + 29 * DAY);
    assert!(s.c.try_settle_after_arbiter_timeout().is_err()); // arbiter gets 30 days after lease end
    jump_to(&s, s.end + 31 * DAY);
    s.c.settle_after_arbiter_timeout();
    assert_eq!(s.t.balance(&s.tenant), 1_007 * USDC);
}

// ---------- DeFindex: split between Blend direct and a DeFindex vault ----------

#[test]
fn split_between_blend_and_defindex_with_yield_from_both() {
    let s = setup_split(8_000, 5_000); // 200 liquid, 400 Blend, 400 DeFindex
    fund(&s);
    assert_eq!(s.t.balance(&s.pool.address), 407 * USDC); // 400 + 7 yield
    assert_eq!(s.t.balance(&s.vault.address), 403 * USDC); // 400 + 3 yield
    let d = s.c.get_deposit();
    assert!(d.in_blend && d.in_vault);
    assert_eq!(d.invested, 800 * USDC);

    propose(&s, 120 * USDC);
    s.c.accept_and_release();
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 890 * USDC); // 880 + 7 (Blend) + 3 (DeFindex)
    let d = s.c.get_deposit();
    assert_eq!(d.state, State::Closed);
    assert!(!d.in_blend && !d.in_vault);
}

#[test]
fn defindex_only() {
    let s = setup_split(7_000, 10_000); // everything invested goes to the vault
    fund(&s);
    assert_eq!(s.t.balance(&s.pool.address), 7 * USDC); // Blend untouched
    propose(&s, 120 * USDC);
    s.c.accept_and_release();
    assert_eq!(s.t.balance(&s.tenant), 883 * USDC); // 880 + 3 vault yield
}

#[test]
fn illiquid_vault_buffer_pays_blend_part_returns_rest_later() {
    let s = setup_split(8_000, 5_000);
    fund(&s);
    propose(&s, 120 * USDC);
    s.vault.set_illiquid(&true);
    s.c.accept_and_release();
    // Buffer (200) + Blend (407) came back: landlord paid, tenant got the rest of that
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 487 * USDC);
    let d = s.c.get_deposit();
    assert_eq!(d.state, State::Settling);
    assert!(!d.in_blend && d.in_vault);

    assert!(s.c.try_claim_remaining().is_err()); // vault still illiquid
    s.vault.set_illiquid(&false);
    s.c.claim_remaining();
    assert_eq!(s.t.balance(&s.tenant), 890 * USDC);
    assert_eq!(s.c.get_deposit().state, State::Closed);
}

#[test]
fn unwind_brings_both_venues_home() {
    let s = setup_split(8_000, 5_000);
    fund(&s);
    jump_to(&s, s.end - 5 * DAY);
    s.c.unwind();
    let d = s.c.get_deposit();
    assert!(!d.in_blend && !d.in_vault);
    assert_eq!(s.t.balance(&s.c.address), 1_010 * USDC); // all back, with both yields
}

#[test]
fn tenant_chooses_the_split() {
    // landlord's default is 50/50, the tenant picks 100% Blend when locking the deposit
    let s = setup_split(8_000, 5_000);
    s.c.fund(
        &s.landlord, &s.arbiter, &s.token, &s.pool.address, &s.vault.address, &DEPOSIT, &s.bps, &0u32,
        &s.ly, &s.end,
    );
    let d = s.c.get_deposit();
    assert_eq!(d.defindex_bps, 0);
    assert!(d.in_blend && !d.in_vault);
}

#[test]
fn tenant_chooses_how_much_to_invest() {
    // landlord's default is 70%, the tenant prefers to keep everything liquid
    let s = setup(7_000);
    s.c.fund(
        &s.landlord, &s.arbiter, &s.token, &s.pool.address, &s.vault.address, &DEPOSIT, &0u32, &s.dfx,
        &s.ly, &s.end,
    );
    let d = s.c.get_deposit();
    assert_eq!(d.invest_bps, 0);
    assert!(!d.in_blend && !d.in_vault);
    assert_eq!(s.t.balance(&s.c.address), DEPOSIT);
}

#[test]
#[should_panic(expected = "invest share above 80%")]
fn tenant_invest_share_is_capped() {
    let s = setup(7_000);
    s.c.fund(
        &s.landlord, &s.arbiter, &s.token, &s.pool.address, &s.vault.address, &DEPOSIT, &8_001u32,
        &s.dfx, &s.ly, &s.end,
    );
}

#[test]
#[should_panic(expected = "split above 100%")]
fn tenant_split_is_capped() {
    let s = setup_split(8_000, 5_000);
    s.c.fund(
        &s.landlord, &s.arbiter, &s.token, &s.pool.address, &s.vault.address, &DEPOSIT, &s.bps,
        &10_001u32, &s.ly, &s.end,
    );
}

/// Real auth (no mock_all_auths): the tenant signs only `fund` and their own transfer;
/// the vault's nested pull from the contract must be covered by the contract's own
/// `authorize_as_current_contract`.
#[test]
fn contract_authorizes_the_vault_pull_itself() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    let s = setup_split(7_000, 10_000); // only the vault path (no Blend approve needed)
    s.env.set_auths(&[]);
    let args = (
        s.landlord.clone(),
        s.arbiter.clone(),
        s.token.clone(),
        s.pool.address.clone(),
        s.vault.address.clone(),
        DEPOSIT,
        s.bps,
        s.dfx,
        s.ly,
        s.end,
    )
        .into_val(&s.env);
    let transfer_args = (s.tenant.clone(), s.c.address.clone(), DEPOSIT).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.tenant,
        invoke: &MockAuthInvoke {
            contract: &s.c.address,
            fn_name: "fund",
            args,
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token,
                fn_name: "transfer",
                args: transfer_args,
                sub_invokes: &[],
            }],
        },
    }]);
    fund(&s);
    assert_eq!(s.t.balance(&s.vault.address), 703 * USDC);
    assert!(s.c.get_deposit().in_vault);
}

// ---------- landlord's share of the yield ----------

#[test]
fn landlord_gets_a_small_share_of_the_yield_only() {
    let s = setup_full(7_000, 0, 500); // 5% of the yield
    fund(&s);
    jump_to(&s, s.end);
    s.c.propose_deduction(&(120 * USDC), &String::from_str(&s.env, "ipfs://x"));
    s.c.accept_and_release();
    let d = s.c.get_deposit();
    // 7 USDC of yield: 5% = 0.35 to the landlord, 6.65 to the tenant; the deposit is untouched
    assert_eq!(d.paid_landlord, 120 * USDC + 3_500_000);
    assert_eq!(d.paid_tenant, 880 * USDC + 66_500_000);
}

#[test]
fn no_yield_no_landlord_share() {
    let s = setup_full(0, 0, 500); // nothing invested, so nothing earned
    fund(&s);
    jump_to(&s, s.end);
    s.c.propose_deduction(&(120 * USDC), &String::from_str(&s.env, "ipfs://x"));
    s.c.accept_and_release();
    let d = s.c.get_deposit();
    assert_eq!(d.paid_landlord, 120 * USDC);
    assert_eq!(d.paid_tenant, 880 * USDC);
}

#[test]
#[should_panic(expected = "landlord yield share above 5%")]
fn landlord_yield_share_is_capped() {
    setup_full(7_000, 0, 501);
}

#[test]
#[should_panic(expected = "terms mismatch")]
fn tenant_commits_to_the_landlord_share() {
    let s = setup_full(7_000, 0, 300);
    s.c.fund(
        &s.landlord, &s.arbiter, &s.token, &s.pool.address, &s.vault.address, &DEPOSIT, &s.bps, &s.dfx,
        &0u32, &s.end,
    );
}

#[test]
fn landlord_share_works_when_money_comes_back_in_two_steps() {
    let s = setup_full(7_000, 0, 500);
    fund(&s);
    propose(&s, 120 * USDC);
    s.pool.set_illiquid(&true);
    s.c.accept_and_release(); // buffer: 120 to the landlord, 180 (deposit) to the tenant
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 180 * USDC);
    s.pool.set_illiquid(&false);
    s.c.claim_remaining(); // 707 back: 700 deposit to the tenant, 7 yield split 5% / 95%
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC + 3_500_000);
    assert_eq!(s.t.balance(&s.tenant), 880 * USDC + 66_500_000);
}
