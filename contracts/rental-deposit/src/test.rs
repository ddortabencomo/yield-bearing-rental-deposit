#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Map, String, Vec,
};

const USDC: i128 = 10_000_000; // 1 USDC with 7 decimals
const YEAR: u64 = 365 * DAY;

/// Fake Blend pool: pulls funds with the allowance on Supply, returns everything it holds on Withdraw.
#[contract]
pub struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn submit_with_allowance(
        env: Env,
        _from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions {
        let me = env.current_contract_address();
        for r in requests.iter() {
            let t = TokenClient::new(&env, &r.address);
            if r.request_type == REQ_SUPPLY {
                t.transfer_from(&me, &spender, &me, &r.amount);
            } else {
                let all = t.balance(&me);
                t.transfer(&me, &to, &all);
            }
        }
        Positions { collateral: Map::new(&env), liabilities: Map::new(&env), supply: Map::new(&env) }
    }
}

struct Setup<'a> {
    env: Env,
    c: RentalDepositClient<'a>,
    t: TokenClient<'a>,
    token: Address,
    pool: Address,
    tenant: Address,
    landlord: Address,
    arbiter: Address,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths(); // skip real signatures in tests
    env.ledger().set_timestamp(1_000_000);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address(); // fake USDC
    let sac = StellarAssetClient::new(&env, &token);
    let tenant = Address::generate(&env);
    let landlord = Address::generate(&env);
    let arbiter = Address::generate(&env);
    sac.mint(&tenant, &(1_000 * USDC));
    let pool = env.register(MockPool, ());
    sac.mint(&pool, &(7 * USDC)); // simulated yield sitting in the pool
    let id = env.register(RentalDeposit, ());
    let c = RentalDepositClient::new(&env, &id);
    let t = TokenClient::new(&env, &token);
    Setup { env, c, t, token, pool, tenant, landlord, arbiter }
}

fn fund(s: &Setup, invest_bps: u32) {
    let end = s.env.ledger().timestamp() + YEAR;
    s.c.fund(&s.tenant, &s.landlord, &s.arbiter, &s.token, &s.pool, &(1_000 * USDC), &invest_bps, &end);
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
    let s = setup();
    fund(&s, 7_000);
    assert_eq!(s.t.balance(&s.pool), 707 * USDC); // 700 supplied + 7 yield
    assert!(s.c.get_deposit().in_blend);

    propose(&s, 120 * USDC);
    s.c.accept_and_release();

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
    let s = setup();
    fund(&s, 0);
    propose(&s, 120 * USDC);
    s.c.accept_and_release();
    assert_eq!(s.t.balance(&s.tenant), 880 * USDC);
    assert_eq!(s.t.balance(&s.pool), 7 * USDC); // pool untouched
}

// ---------- who can sign ----------

#[test]
fn only_landlord_signs_proposal_and_only_tenant_accepts() {
    let s = setup();
    fund(&s, 7_000);
    propose(&s, 120 * USDC);
    assert_eq!(s.env.auths()[0].0, s.landlord);
    s.c.accept_and_release();
    assert_eq!(s.env.auths()[0].0, s.tenant);
}

// ---------- input checks ----------

#[test]
#[should_panic(expected = "deduction out of range")]
fn deduction_cannot_exceed_deposit() {
    let s = setup();
    fund(&s, 7_000);
    propose(&s, 1_001 * USDC);
}

#[test]
#[should_panic(expected = "invest share above 80%")]
fn cannot_invest_more_than_80_percent() {
    let s = setup();
    fund(&s, 9_000);
}

#[test]
#[should_panic(expected = "tenant and landlord must differ")]
fn tenant_cannot_be_landlord() {
    let s = setup();
    let end = s.env.ledger().timestamp() + YEAR;
    s.c.fund(&s.tenant, &s.tenant, &s.arbiter, &s.token, &s.pool, &(1_000 * USDC), &7_000, &end);
}

#[test]
#[should_panic(expected = "arbiter must be neutral")]
fn arbiter_must_be_neutral() {
    let s = setup();
    let end = s.env.ledger().timestamp() + YEAR;
    s.c.fund(&s.tenant, &s.landlord, &s.landlord, &s.token, &s.pool, &(1_000 * USDC), &7_000, &end);
}

#[test]
#[should_panic(expected = "already funded")]
fn cannot_fund_twice() {
    let s = setup();
    fund(&s, 0);
    fund(&s, 0);
}

// ---------- disputes ----------

#[test]
#[should_panic(expected = "wrong state")]
fn dispute_blocks_release() {
    let s = setup();
    fund(&s, 7_000);
    propose(&s, 120 * USDC);
    s.c.dispute();
    s.c.accept_and_release();
}

#[test]
fn arbiter_resolves_dispute() {
    let s = setup();
    fund(&s, 7_000);
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
    let s = setup();
    fund(&s, 7_000);
    propose(&s, 120 * USDC);
    s.c.dispute();
    s.c.resolve(&(121 * USDC));
}

// ---------- early unwind (liquidity control) ----------

#[test]
#[should_panic(expected = "unwind window not open")]
fn unwind_too_early() {
    let s = setup();
    fund(&s, 7_000);
    s.c.unwind();
}

#[test]
fn unwind_in_last_30_days_then_settle() {
    let s = setup();
    fund(&s, 7_000);
    let end = s.c.get_deposit().lease_end;
    jump_to(&s, end - 10 * DAY);
    s.c.unwind(); // anyone can call it
    assert_eq!(s.t.balance(&s.pool), 0);
    assert!(!s.c.get_deposit().in_blend);

    propose(&s, 120 * USDC);
    s.c.accept_and_release(); // no Blend call needed anymore
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 887 * USDC);
}

// ---------- timeouts (nobody can hold the deposit hostage) ----------

#[test]
fn tenant_refunded_if_landlord_never_claims() {
    let s = setup();
    fund(&s, 7_000);
    let end = s.c.get_deposit().lease_end;
    jump_to(&s, end + 15 * DAY);
    s.c.claim_full_refund();
    assert_eq!(s.t.balance(&s.tenant), 1_007 * USDC);
    assert_eq!(s.t.balance(&s.landlord), 0);
}

#[test]
#[should_panic(expected = "too early")]
fn refund_not_before_response_window() {
    let s = setup();
    fund(&s, 7_000);
    let end = s.c.get_deposit().lease_end;
    jump_to(&s, end + 13 * DAY);
    s.c.claim_full_refund();
}

#[test]
fn landlord_finalizes_if_tenant_silent() {
    let s = setup();
    fund(&s, 7_000);
    propose(&s, 120 * USDC);
    let t0 = s.env.ledger().timestamp();
    jump_to(&s, t0 + 15 * DAY);
    s.c.finalize_deduction();
    assert_eq!(s.t.balance(&s.landlord), 120 * USDC);
    assert_eq!(s.t.balance(&s.tenant), 887 * USDC);
}

#[test]
fn anyone_can_extend_ttl() {
    let s = setup();
    fund(&s, 7_000);
    s.c.extend_ttl();
    assert_eq!(s.c.get_deposit().state, State::Funded);
}
