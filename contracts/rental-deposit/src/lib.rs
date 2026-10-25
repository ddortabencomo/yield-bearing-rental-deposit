#![no_std]
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, vec, Address, Env, Map, String,
    Vec,
};

/// Max share of the deposit that can go to Blend (80%). The rest is the liquidity buffer.
const MAX_INVEST_BPS: u32 = 8_000;
const REQ_SUPPLY: u32 = 0;
const REQ_WITHDRAW: u32 = 1;
const DAY: u64 = 86_400;
/// `unwind()` opens this long before the lease ends: funds leave Blend early,
/// so a busy pool on settlement day can't delay the payout.
const UNWIND_WINDOW: u64 = 30 * DAY;
/// How long the other party has to act before the waiting party can force settlement.
const RESPONSE_WINDOW: u64 = 14 * DAY;

// ---------- Blend pool interface (only what we use) ----------

#[contracttype]
#[derive(Clone, Debug)]
pub struct Request {
    pub address: Address, // asset to supply/withdraw
    pub amount: i128,
    pub request_type: u32, // 0 = Supply, 1 = Withdraw
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Positions {
    pub collateral: Map<u32, i128>,
    pub liabilities: Map<u32, i128>,
    pub supply: Map<u32, i128>,
}

#[contractclient(name = "PoolClient")]
pub trait BlendPool {
    fn submit_with_allowance(
        env: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions;
}

// ---------- Rental deposit ----------

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Funded,
    DeductionProposed,
    Disputed,
    Closed,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Deposit {
    pub tenant: Address,
    pub landlord: Address,
    pub arbiter: Address, // neutral third party that resolves disputes
    pub token: Address,
    pub pool: Address,     // Blend pool where the invested share earns yield
    pub amount: i128,      // USDC has 7 decimals: 1 USDC = 10_000_000
    pub invest_bps: u32,   // share sent to Blend, in basis points (7000 = 70%)
    pub invested: i128,    // amount supplied to Blend
    pub in_blend: bool,    // false once unwound or settled
    pub lease_end: u64,    // unix timestamp (seconds)
    pub deduction: i128,
    pub evidence: String,  // link or hash of the landlord's evidence
    pub proposed_at: u64,  // when the deduction was proposed
    pub paid_landlord: i128,
    pub paid_tenant: i128,
    pub state: State,
}

#[contracttype]
pub enum DataKey {
    Deposit,
}

#[contract]
pub struct RentalDeposit;

/// Ledgers close every ~5 s: ~17,280 ledgers per day.
const LEDGERS_PER_DAY: u32 = 17_280;
/// Extend only when less than ~30 days of life remain, up to ~60 days.
const TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;
const TTL_EXTEND_TO: u32 = 60 * LEDGERS_PER_DAY;

fn load(env: &Env) -> Deposit {
    env.storage().instance().get(&DataKey::Deposit).expect("no deposit")
}

fn save(env: &Env, d: &Deposit) {
    env.storage().instance().set(&DataKey::Deposit, d);
}

/// Pull everything (principal + yield) back from Blend into this contract.
fn withdraw_all(env: &Env, d: &mut Deposit) {
    if d.in_blend {
        let me = env.current_contract_address();
        // i128::MAX = "withdraw all": Blend caps it at our position (tested on testnet)
        PoolClient::new(env, &d.pool).submit_with_allowance(
            &me,
            &me,
            &me,
            &vec![
                env,
                Request { address: d.token.clone(), amount: i128::MAX, request_type: REQ_WITHDRAW },
            ],
        );
        d.in_blend = false;
    }
}

/// Waterfall: 1) the landlord's deduction, 2) everything else (principal + yield) to the tenant.
fn settle(env: &Env, d: &mut Deposit, deduction: i128) {
    withdraw_all(env, d);
    let me = env.current_contract_address();
    let t = token::Client::new(env, &d.token);
    let total = t.balance(&me); // liquid buffer + principal back from Blend + yield

    let to_landlord = deduction.min(total);
    let to_tenant = total - to_landlord;
    if to_landlord > 0 {
        t.transfer(&me, &d.landlord, &to_landlord);
    }
    if to_tenant > 0 {
        t.transfer(&me, &d.tenant, &to_tenant);
    }
    d.deduction = deduction;
    d.paid_landlord = to_landlord;
    d.paid_tenant = to_tenant;
    d.state = State::Closed;
    save(env, d);
}

#[contractimpl]
impl RentalDeposit {
    /// Tenant locks the deposit; the invested share goes to Blend, the rest stays liquid.
    pub fn fund(
        env: Env,
        tenant: Address,
        landlord: Address,
        arbiter: Address,
        token: Address,
        pool: Address,
        amount: i128,
        invest_bps: u32,
        lease_end: u64,
    ) {
        tenant.require_auth();
        assert!(!env.storage().instance().has(&DataKey::Deposit), "already funded");
        assert!(amount > 0, "amount must be positive");
        assert!(invest_bps <= MAX_INVEST_BPS, "invest share above 80%");
        assert!(tenant != landlord, "tenant and landlord must differ");
        assert!(arbiter != tenant && arbiter != landlord, "arbiter must be neutral");
        assert!(lease_end > env.ledger().timestamp(), "lease already ended");

        let me = env.current_contract_address();
        let t = token::Client::new(&env, &token);
        t.transfer(&tenant, &me, &amount);

        let invested = amount * invest_bps as i128 / 10_000;
        if invested > 0 {
            // 1) allow the pool to pull exactly `invested` from this contract
            t.approve(&me, &pool, &invested, &(env.ledger().sequence() + 1_000));
            // 2) ask the pool to pull it and record it as our supply position
            PoolClient::new(&env, &pool).submit_with_allowance(
                &me,
                &me,
                &me,
                &vec![
                    &env,
                    Request { address: token.clone(), amount: invested, request_type: REQ_SUPPLY },
                ],
            );
        }

        save(
            &env,
            &Deposit {
                tenant,
                landlord,
                arbiter,
                token,
                pool,
                amount,
                invest_bps,
                invested,
                in_blend: invested > 0,
                lease_end,
                deduction: 0,
                evidence: String::from_str(&env, ""),
                proposed_at: 0,
                paid_landlord: 0,
                paid_tenant: 0,
                state: State::Funded,
            },
        );
    }

    /// Landlord proposes a deduction at the end of the lease.
    pub fn propose_deduction(env: Env, deduction: i128, evidence: String) {
        let mut d = load(&env);
        d.landlord.require_auth();
        assert!(d.state == State::Funded, "wrong state");
        assert!(deduction >= 0 && deduction <= d.amount, "deduction out of range");
        d.deduction = deduction;
        d.evidence = evidence;
        d.proposed_at = env.ledger().timestamp();
        d.state = State::DeductionProposed;
        save(&env, &d);
    }

    /// Tenant accepts: withdraw everything from Blend, then pay out with the waterfall.
    pub fn accept_and_release(env: Env) {
        let mut d = load(&env);
        d.tenant.require_auth();
        assert!(d.state == State::DeductionProposed, "wrong state");
        let deduction = d.deduction;
        settle(&env, &mut d, deduction);
    }

    /// Tenant rejects the deduction: payout is frozen until the arbiter decides.
    pub fn dispute(env: Env) {
        let mut d = load(&env);
        d.tenant.require_auth();
        assert!(d.state == State::DeductionProposed, "wrong state");
        d.state = State::Disputed;
        save(&env, &d);
    }

    /// Arbiter settles a dispute with the deduction they decide (≤ what the landlord asked).
    pub fn resolve(env: Env, deduction: i128) {
        let mut d = load(&env);
        d.arbiter.require_auth();
        assert!(d.state == State::Disputed, "wrong state");
        assert!(deduction >= 0 && deduction <= d.deduction, "deduction out of range");
        settle(&env, &mut d, deduction);
    }

    /// Anyone can move the funds out of Blend during the last 30 days of the lease
    /// (or after it), so settlement never depends on the pool's liquidity that day.
    pub fn unwind(env: Env) {
        let mut d = load(&env);
        assert!(d.state != State::Closed, "already settled");
        assert!(d.in_blend, "nothing in Blend");
        assert!(
            env.ledger().timestamp() + UNWIND_WINDOW >= d.lease_end,
            "unwind window not open"
        );
        withdraw_all(&env, &mut d);
        save(&env, &d);
    }

    /// Landlord never proposed: 14 days after the lease ends, the tenant gets everything back.
    pub fn claim_full_refund(env: Env) {
        let mut d = load(&env);
        d.tenant.require_auth();
        assert!(d.state == State::Funded, "wrong state");
        assert!(env.ledger().timestamp() > d.lease_end + RESPONSE_WINDOW, "too early");
        settle(&env, &mut d, 0);
    }

    /// Tenant never answered: 14 days after the proposal, the landlord can settle with it.
    pub fn finalize_deduction(env: Env) {
        let mut d = load(&env);
        d.landlord.require_auth();
        assert!(d.state == State::DeductionProposed, "wrong state");
        assert!(env.ledger().timestamp() > d.proposed_at + RESPONSE_WINDOW, "too early");
        let deduction = d.deduction;
        settle(&env, &mut d, deduction);
    }

    /// Soroban storage expires unless its TTL is extended, and a lease lasts a year or more.
    /// A new contract starts with the network's minimum lifetime (months); during the lease
    /// anyone (e.g. a keeper bot) calls this periodically. It only pays rent when less than
    /// ~30 days remain, so calling it often is cheap.
    pub fn extend_ttl(env: Env) {
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    /// Read-only: the web uses this to show the deposit status.
    pub fn get_deposit(env: Env) -> Deposit {
        load(&env)
    }
}

mod test;
