#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::Address as _, token::{StellarAssetClient, TokenClient}, Address, Env, Map, String, Vec};

const USDC: i128 = 10_000_000; // 1 USDC with 7 decimals

/// Fake Blend pool: pulls funds with the allowance on Supply, returns everything it holds on Withdraw.
#[contract]
pub struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn submit_with_allowance(env: Env, _from: Address, spender: Address, to: Address, requests: Vec<Request>) -> Positions {
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

fn setup<'a>(env: &'a Env) -> (RentalDepositClient<'a>, Address, Address, Address, Address) {
    env.mock_all_auths(); // skip real signatures in tests
    let admin = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(admin).address(); // fake USDC
    let sac = StellarAssetClient::new(env, &token);
    let tenant = Address::generate(env);
    let landlord = Address::generate(env);
    sac.mint(&tenant, &(1_000 * USDC));
    let pool = env.register(MockPool, ());
    sac.mint(&pool, &(7 * USDC)); // simulated yield sitting in the pool
    let id = env.register(RentalDeposit, ());
    (RentalDepositClient::new(env, &id), token, pool, tenant, landlord)
}

#[test]
fn happy_path_with_yield() {
    let env = Env::default();
    let (c, token, pool, tenant, landlord) = setup(&env);
    let t = TokenClient::new(&env, &token);

    c.fund(&tenant, &landlord, &token, &pool, &(1_000 * USDC), &7_000);
    assert_eq!(t.balance(&pool), 707 * USDC); // 700 supplied + 7 yield
    assert_eq!(c.get_deposit().invested, 700 * USDC);

    c.propose_deduction(&(120 * USDC), &String::from_str(&env, "ipfs://photos"));
    c.accept_and_release();

    assert_eq!(t.balance(&landlord), 120 * USDC);
    assert_eq!(t.balance(&tenant), 887 * USDC); // 880 + 7 yield
    assert_eq!(c.get_deposit().state, State::Closed);
}

#[test]
fn zero_invest_skips_blend() {
    let env = Env::default();
    let (c, token, pool, tenant, landlord) = setup(&env);
    let t = TokenClient::new(&env, &token);
    c.fund(&tenant, &landlord, &token, &pool, &(1_000 * USDC), &0);
    c.propose_deduction(&(120 * USDC), &String::from_str(&env, ""));
    c.accept_and_release();
    assert_eq!(t.balance(&tenant), 880 * USDC);
    assert_eq!(t.balance(&pool), 7 * USDC); // pool untouched
}

#[test]
#[should_panic]
fn deduction_cannot_exceed_deposit() {
    let env = Env::default();
    let (c, token, pool, tenant, landlord) = setup(&env);
    c.fund(&tenant, &landlord, &token, &pool, &(1_000 * USDC), &7_000);
    c.propose_deduction(&(1_001 * USDC), &String::from_str(&env, ""));
}

#[test]
#[should_panic]
fn cannot_invest_more_than_80_percent() {
    let env = Env::default();
    let (c, token, pool, tenant, landlord) = setup(&env);
    c.fund(&tenant, &landlord, &token, &pool, &(1_000 * USDC), &9_000);
}

#[test]
#[should_panic]
fn dispute_blocks_release() {
    let env = Env::default();
    let (c, token, pool, tenant, landlord) = setup(&env);
    c.fund(&tenant, &landlord, &token, &pool, &(1_000 * USDC), &7_000);
    c.propose_deduction(&(120 * USDC), &String::from_str(&env, ""));
    c.dispute();
    c.accept_and_release();
}