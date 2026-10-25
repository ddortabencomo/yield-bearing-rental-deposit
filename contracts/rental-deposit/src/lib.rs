#![no_std]
//! Yield-bearing rental deposit: one agreement per contract instance.
//!
//! Lifecycle:
//!   1. deploy (`__constructor`): the landlord creates the agreement with its terms, atomically
//!   2. `fund`: the tenant re-states the terms and deposits; up to 80% is supplied to Blend
//!   3. `propose_deduction`: the landlord asks for an amount
//!   4. `accept_and_release` / `dispute` + `resolve` / timeouts settle with a fixed waterfall:
//!      the landlord's deduction first, everything else (principal + yield) to the tenant.
//! The liquid buffer pays out even if Blend can't return funds that day; the rest is
//! claimed later with `claim_remaining`.
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
/// If the arbiter doesn't resolve a dispute in this time, the tenant can settle with no deduction.
const ARBITER_WINDOW: u64 = 30 * DAY;
/// Longest lease accepted (also keeps timestamp arithmetic far from overflow).
const MAX_LEASE: u64 = 5 * 365 * DAY;
/// Max length of the landlord's evidence (a link or a hash).
const MAX_EVIDENCE_LEN: u32 = 256;
/// Ledgers close every ~5 s: ~17,280 ledgers per day.
const LEDGERS_PER_DAY: u32 = 17_280;
/// `extend_ttl` only pays rent when less than ~30 days of life remain, extending to ~60 days.
const TTL_THRESHOLD: u32 = 30 * LEDGERS_PER_DAY;
const TTL_EXTEND_TO: u32 = 60 * LEDGERS_PER_DAY;

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
    Offered,           // landlord created the agreement, waiting for the tenant's deposit
    Funded,            // deposit locked (and partly earning in Blend)
    DeductionProposed, // landlord asked for a deduction
    Disputed,          // tenant rejected it: frozen until the arbiter decides (or times out)
    Settling,          // liquid part paid out; the rest waits for Blend liquidity
    Closed,            // everything paid out (or the offer was cancelled)
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Deposit {
    pub tenant: Address,
    pub landlord: Address,
    pub arbiter: Address,    // neutral third party that resolves disputes
    pub token: Address,
    pub pool: Address,       // Blend pool where the invested share earns yield
    pub amount: i128,        // USDC has 7 decimals: 1 USDC = 10_000_000
    pub invest_bps: u32,     // share sent to Blend, in basis points (7000 = 70%)
    pub invested: i128,      // amount supplied to Blend
    pub in_blend: bool,      // true while funds sit in Blend
    pub lease_end: u64,      // unix timestamp (seconds)
    pub deduction: i128,
    pub evidence: String,    // link or hash of the landlord's evidence
    pub proposed_at: u64,    // when the deduction was proposed
    pub disputed_at: u64,    // when the tenant disputed it
    pub owed_landlord: i128, // deduction not paid yet (only while Settling)
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

fn load(env: &Env) -> Deposit {
    env.storage().instance().get(&DataKey::Deposit).expect("no deposit")
}

fn save(env: &Env, d: &Deposit) {
    env.storage().instance().set(&DataKey::Deposit, d);
}

fn withdraw_request(env: &Env, d: &Deposit) -> Vec<Request> {
    // i128::MAX = "withdraw all": Blend caps it at our position (tested on testnet)
    vec![
        env,
        Request { address: d.token.clone(), amount: i128::MAX, request_type: REQ_WITHDRAW },
    ]
}

/// True if the pool reports no supply left for us (Blend returns our positions after
/// every submit). Guards against a withdrawal that succeeds only partially.
fn nothing_left(p: &Positions) -> bool {
    p.supply.values().iter().all(|b| b <= 0)
}

/// Pull everything (principal + yield) back from Blend. Panics if Blend can't pay;
/// if it only pays part, the rest stays recorded as `in_blend`.
fn withdraw_all(env: &Env, d: &mut Deposit) {
    if d.in_blend {
        let me = env.current_contract_address();
        let left = PoolClient::new(env, &d.pool)
            .submit_with_allowance(&me, &me, &me, &withdraw_request(env, d));
        d.in_blend = !nothing_left(&left);
    }
}

/// Same, but never fails: returns false if Blend can't return everything right now
/// (e.g. the pool is fully borrowed); a failed call is rolled back. If the call succeeded
/// but its result can't be read, we can't prove the position is empty, so we stay
/// conservative and keep it recorded as in Blend (the agreement waits in `Settling`).
fn try_withdraw_all(env: &Env, d: &mut Deposit) -> bool {
    if !d.in_blend {
        return true;
    }
    let me = env.current_contract_address();
    let res = PoolClient::new(env, &d.pool)
        .try_submit_with_allowance(&me, &me, &me, &withdraw_request(env, d));
    match res {
        Ok(Ok(left)) => d.in_blend = !nothing_left(&left),
        Ok(Err(_)) | Err(_) => {}
    }
    !d.in_blend
}

/// Pay whatever the contract holds with the waterfall:
/// 1) what is still owed to the landlord, 2) the rest to the tenant.
fn pay_out(env: &Env, d: &mut Deposit) {
    let me = env.current_contract_address();
    let t = token::Client::new(env, &d.token);
    let mut available = t.balance(&me);

    let to_landlord = d.owed_landlord.min(available);
    if to_landlord > 0 {
        t.transfer(&me, &d.landlord, &to_landlord);
        d.paid_landlord += to_landlord;
        d.owed_landlord -= to_landlord;
        available -= to_landlord;
    }
    if d.owed_landlord == 0 && available > 0 {
        t.transfer(&me, &d.tenant, &available);
        d.paid_tenant += available;
    }
}

/// Settle with a final deduction. The liquid buffer pays immediately; if Blend can't
/// return its part today, the agreement moves to `Settling` and `claim_remaining` finishes it.
fn settle(env: &Env, d: &mut Deposit, deduction: i128) {
    d.deduction = deduction;
    d.owed_landlord = deduction;
    let withdrawn = try_withdraw_all(env, d);
    pay_out(env, d);
    d.state = if withdrawn { State::Closed } else { State::Settling };
    save(env, d);
}

#[contractimpl]
impl RentalDeposit {
    /// The landlord creates the agreement with its terms in the same transaction as the
    /// deployment, so nobody can front-run the set-up. The tenant accepts by calling `fund`.
    pub fn __constructor(
        env: Env,
        landlord: Address,
        tenant: Address,
        arbiter: Address,
        token: Address,
        pool: Address,
        amount: i128,
        invest_bps: u32,
        lease_end: u64,
    ) {
        landlord.require_auth();
        let now = env.ledger().timestamp();
        assert!(amount > 0, "amount must be positive");
        assert!(invest_bps <= MAX_INVEST_BPS, "invest share above 80%");
        assert!(tenant != landlord, "tenant and landlord must differ");
        assert!(arbiter != tenant && arbiter != landlord, "arbiter must be neutral");
        assert!(lease_end > now, "lease already ended");
        assert!(lease_end <= now.saturating_add(MAX_LEASE), "lease longer than 5 years");

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
                invested: 0,
                in_blend: false,
                lease_end,
                deduction: 0,
                evidence: String::from_str(&env, ""),
                proposed_at: 0,
                disputed_at: 0,
                owed_landlord: 0,
                paid_landlord: 0,
                paid_tenant: 0,
                state: State::Offered,
            },
        );
    }

    /// Tenant accepts the landlord's terms by locking the deposit. The tenant re-states the
    /// terms, so their signature commits to exactly what they saw (the wallet shows them).
    /// The invested share goes to Blend; the rest stays liquid.
    pub fn fund(
        env: Env,
        landlord: Address,
        arbiter: Address,
        token: Address,
        pool: Address,
        amount: i128,
        invest_bps: u32,
        lease_end: u64,
    ) {
        let mut d = load(&env);
        d.tenant.require_auth();
        assert!(d.state == State::Offered, "wrong state");
        assert!(
            landlord == d.landlord
                && arbiter == d.arbiter
                && token == d.token
                && pool == d.pool
                && amount == d.amount
                && invest_bps == d.invest_bps
                && lease_end == d.lease_end,
            "terms mismatch"
        );
        assert!(d.lease_end > env.ledger().timestamp(), "lease already ended");

        let me = env.current_contract_address();
        let t = token::Client::new(&env, &d.token);
        t.transfer(&d.tenant, &me, &d.amount);

        let invested = d.amount * d.invest_bps as i128 / 10_000;
        if invested > 0 {
            // 1) allow the pool to pull exactly `invested` from this contract
            t.approve(&me, &d.pool, &invested, &(env.ledger().sequence() + 1_000));
            // 2) ask the pool to pull it and record it as our supply position
            PoolClient::new(&env, &d.pool).submit_with_allowance(
                &me,
                &me,
                &me,
                &vec![
                    &env,
                    Request { address: d.token.clone(), amount: invested, request_type: REQ_SUPPLY },
                ],
            );
        }
        d.invested = invested;
        d.in_blend = invested > 0;
        d.state = State::Funded;
        save(&env, &d);
    }

    /// Landlord withdraws an offer the tenant hasn't funded yet.
    pub fn cancel_offer(env: Env) {
        let mut d = load(&env);
        d.landlord.require_auth();
        assert!(d.state == State::Offered, "wrong state");
        d.state = State::Closed;
        save(&env, &d);
    }

    /// Landlord proposes a deduction (normally at the end of the lease).
    pub fn propose_deduction(env: Env, deduction: i128, evidence: String) {
        let mut d = load(&env);
        d.landlord.require_auth();
        assert!(d.state == State::Funded, "wrong state");
        assert!(deduction >= 0 && deduction <= d.amount, "deduction out of range");
        assert!(evidence.len() <= MAX_EVIDENCE_LEN, "evidence too long");
        d.deduction = deduction;
        d.evidence = evidence;
        d.proposed_at = env.ledger().timestamp();
        d.state = State::DeductionProposed;
        save(&env, &d);
    }

    /// Tenant accepts: pay out with the waterfall.
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
        d.disputed_at = env.ledger().timestamp();
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

    /// The arbiter never decided: 30 days after the dispute AND after the lease ends, the
    /// tenant can settle with no deduction, so nobody can keep the deposit frozen forever,
    /// and the deposit still backs the lease until it ends.
    pub fn settle_after_arbiter_timeout(env: Env) {
        let mut d = load(&env);
        d.tenant.require_auth();
        assert!(d.state == State::Disputed, "wrong state");
        let start = d.disputed_at.max(d.lease_end);
        assert!(env.ledger().timestamp() > start.saturating_add(ARBITER_WINDOW), "too early");
        settle(&env, &mut d, 0);
    }

    /// Anyone can finish a settlement once Blend has liquidity again. If Blend can only
    /// return part of it, that part is paid out and the agreement stays in `Settling`.
    pub fn claim_remaining(env: Env) {
        let mut d = load(&env);
        assert!(d.state == State::Settling, "wrong state");
        withdraw_all(&env, &mut d);
        pay_out(&env, &mut d);
        if !d.in_blend {
            d.state = State::Closed;
        }
        save(&env, &d);
    }

    /// Anyone can move the funds out of Blend during the last 30 days of the lease
    /// (or after it), so settlement never depends on the pool's liquidity that day.
    pub fn unwind(env: Env) {
        let mut d = load(&env);
        assert!(
            d.state == State::Funded
                || d.state == State::DeductionProposed
                || d.state == State::Disputed,
            "wrong state"
        );
        assert!(d.in_blend, "nothing in Blend");
        assert!(
            env.ledger().timestamp().saturating_add(UNWIND_WINDOW) >= d.lease_end,
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
        assert!(
            env.ledger().timestamp() > d.lease_end.saturating_add(RESPONSE_WINDOW),
            "too early"
        );
        settle(&env, &mut d, 0);
    }

    /// Tenant never answered: 14 days after the proposal AND after the lease ends, the
    /// landlord can settle with it. A deduction proposed early can only be paid early if
    /// the tenant accepts it.
    pub fn finalize_deduction(env: Env) {
        let mut d = load(&env);
        d.landlord.require_auth();
        assert!(d.state == State::DeductionProposed, "wrong state");
        let start = d.proposed_at.max(d.lease_end);
        assert!(env.ledger().timestamp() > start.saturating_add(RESPONSE_WINDOW), "too early");
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

    /// Read-only: the web uses this to show the agreement.
    pub fn get_deposit(env: Env) -> Deposit {
        load(&env)
    }
}

mod test;
