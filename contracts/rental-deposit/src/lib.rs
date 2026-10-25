#![no_std]
use soroban_sdk::{contract, contractclient, contractimpl, contracttype, token, vec, Address, Env, Map, String, Vec};

/// Max share of the deposit that can go to Blend (80%). The rest is the liquidity buffer.
const MAX_INVEST_BPS: u32 = 8_000;
const REQ_SUPPLY: u32 = 0;
const REQ_WITHDRAW: u32 = 1;

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
    fn submit_with_allowance(env: Env, from: Address, spender: Address, to: Address, requests: Vec<Request>) -> Positions;
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
    pub token: Address,
    pub pool: Address,    // Blend pool where the invested share earns yield
    pub amount: i128,     // USDC has 7 decimals: 1 USDC = 10_000_000
    pub invest_bps: u32,  // share sent to Blend, in basis points (7000 = 70%)
    pub invested: i128,   // amount actually supplied to Blend
    pub deduction: i128,
    pub evidence: String, // link or hash of the landlord's evidence
    pub state: State,
}

#[contracttype]
pub enum DataKey {
    Deposit,
}

#[contract]
pub struct RentalDeposit;

fn load(env: &Env) -> Deposit {
    env.storage().persistent().get(&DataKey::Deposit).expect("no deposit")
}

fn save(env: &Env, d: &Deposit) {
    env.storage().persistent().set(&DataKey::Deposit, d);
}

#[contractimpl]
impl RentalDeposit {
    /// Tenant locks the deposit; the invested share goes to Blend, the rest stays liquid.
    pub fn fund(env: Env, tenant: Address, landlord: Address, token: Address, pool: Address, amount: i128, invest_bps: u32) {
        tenant.require_auth();
        assert!(!env.storage().persistent().has(&DataKey::Deposit), "already funded");
        assert!(amount > 0, "amount must be positive");
        assert!(invest_bps <= MAX_INVEST_BPS, "invest share above 80%");

        let me = env.current_contract_address();
        let t = token::Client::new(&env, &token);
        t.transfer(&tenant, &me, &amount);

        let invested = amount * invest_bps as i128 / 10_000;
        if invested > 0 {
            // 1) allow the pool to pull exactly `invested` from this contract
            t.approve(&me, &pool, &invested, &(env.ledger().sequence() + 1_000));
            // 2) ask the pool to pull it and record it as our supply position
            PoolClient::new(&env, &pool).submit_with_allowance(
                &me, &me, &me,
                &vec![&env, Request { address: token.clone(), amount: invested, request_type: REQ_SUPPLY }],
            );
        }

        save(&env, &Deposit {
            tenant, landlord, token, pool, amount, invest_bps, invested,
            deduction: 0,
            evidence: String::from_str(&env, ""),
            state: State::Funded,
        });
    }

    /// Landlord proposes a deduction at the end of the lease.
    pub fn propose_deduction(env: Env, deduction: i128, evidence: String) {
        let mut d = load(&env);
        d.landlord.require_auth();
        assert!(d.state == State::Funded, "wrong state");
        assert!(deduction >= 0 && deduction <= d.amount, "deduction out of range");
        d.deduction = deduction;
        d.evidence = evidence;
        d.state = State::DeductionProposed;
        save(&env, &d);
    }

    /// Tenant rejects the deduction: payout is frozen until an arbiter decides.
    pub fn dispute(env: Env) {
        let mut d = load(&env);
        d.tenant.require_auth();
        assert!(d.state == State::DeductionProposed, "wrong state");
        d.state = State::Disputed;
        save(&env, &d);
    }

    /// Tenant accepts: withdraw everything from Blend, then pay out with the waterfall.
    /// 1) landlord's deduction, 2) everything else (principal + yield) to the tenant.
    pub fn accept_and_release(env: Env) {
        let mut d = load(&env);
        d.tenant.require_auth();
        assert!(d.state == State::DeductionProposed, "wrong state");

        let me = env.current_contract_address();
        if d.invested > 0 {
            // i128::MAX = "withdraw all": Blend caps it at our position (tested on testnet)
            PoolClient::new(&env, &d.pool).submit_with_allowance(
                &me, &me, &me,
                &vec![&env, Request { address: d.token.clone(), amount: i128::MAX, request_type: REQ_WITHDRAW }],
            );
        }

        let t = token::Client::new(&env, &d.token);
        let total = t.balance(&me); // liquid buffer + principal back from Blend + yield

        let to_landlord = d.deduction.min(total);
        let to_tenant = total - to_landlord;
        if to_landlord > 0 { t.transfer(&me, &d.landlord, &to_landlord); }
        if to_tenant > 0 { t.transfer(&me, &d.tenant, &to_tenant); }

        d.state = State::Closed;
        save(&env, &d);
    }

    /// Read-only: the web uses this to show the deposit status.
    pub fn get_deposit(env: Env) -> Deposit {
        load(&env)
    }
}

mod test;