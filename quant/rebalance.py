"""
Quant layer, part 2: the risk model manages the shared DeFindex reserve.

Every Blendlord agreement can route part of its invested share to one shared DeFindex
vault ("Blendlord Deposit Reserve"). The vault keeps funds either IDLE (instant liquidity
for every lease) or INVESTED in the Blend USDC strategy. This script is the vault's
Rebalance Manager: it reads the live state and moves funds between the two.

Policy (simple, explainable, tunable):
  * Liquidity risk q rises with Blend utilization U (a fully borrowed pool can't pay out).
    target = TARGET_MAX                    if U <= U_SAFE
           = linearly down to 0            if U_SAFE < U < U_STOP
           = 0                             if U >= U_STOP   (pull everything to idle)
  * Glide path: if any lease ends within GLIDE_DAYS, cap the target at GLIDE_TARGET
    (the shared reserve builds liquidity ahead of move-outs).
The escrow contracts still enforce the hard rules (80% cap, waterfall, timeouts):
the model proposes, the contracts constrain.

Usage (PowerShell, from the repo root):
  python quant/rebalance.py                       # dry run: show state and the plan
  python quant/rebalance.py --execute             # send the rebalance (signs as alice)
  python quant/rebalance.py --days-to-lease-end 10 --execute   # glide path demo
"""
import argparse
import json
import subprocess
import sys

VAULT = "CDULNJ6EKQJJRPPZIGZ3R4T2W3DVTDFQTAMX3RBVV3RII5JJAXZQRDED"  # Blendlord Deposit Reserve
STRATEGY = "CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY"  # DeFindex Blend USDC strategy
POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"  # Blend TestnetV2
USDC = "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU"

TARGET_MAX = 0.90  # at most 90% of the shared reserve in Blend
U_SAFE, U_STOP = 0.85, 0.94  # utilization band where we de-risk
GLIDE_DAYS, GLIDE_TARGET = 30, 0.0
MIN_MOVE = 1_000_000  # ignore moves below 0.1 USDC

SOURCE = "alice"  # Rebalance Manager role of the vault
NET = ["--network", "testnet"]


def invoke(contract: str, fn: str, *args: str, send: bool = False) -> object:
    cmd = ["stellar", "contract", "invoke", "--id", contract, "--source-account", SOURCE, *NET]
    if send:
        cmd += ["--send", "yes"]
    cmd += ["--", fn, *args]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0:
        sys.exit(f"stellar CLI failed:\n{out.stderr.strip()[-1500:]}")
    lines = [l for l in out.stdout.strip().splitlines() if l.strip()]
    if not lines:
        return None
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        return lines[-1]


def utilization() -> float:
    r = invoke(POOL, "get_reserve", "--asset", USDC)
    d = r["data"]
    supplied = int(d["b_supply"]) * int(d["b_rate"]) / 1e12
    borrowed = int(d["d_supply"]) * int(d["d_rate"]) / 1e12
    return borrowed / supplied if supplied else 0.0


def vault_state() -> tuple[int, int]:
    funds = invoke(VAULT, "fetch_total_managed_funds")
    a = funds[0]
    return int(a["idle_amount"]), int(a["invested_amount"])


def target_share(u: float, days_to_lease_end: float | None) -> float:
    if u <= U_SAFE:
        t = TARGET_MAX
    elif u >= U_STOP:
        t = 0.0
    else:
        t = TARGET_MAX * (U_STOP - u) / (U_STOP - U_SAFE)
    if days_to_lease_end is not None and days_to_lease_end <= GLIDE_DAYS:
        t = min(t, GLIDE_TARGET)
    return t


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--execute", action="store_true", help="send the rebalance transaction")
    ap.add_argument("--days-to-lease-end", type=float, default=None,
                    help="days until the next lease in the reserve ends (glide path)")
    args = ap.parse_args()

    u = utilization()
    idle, invested = vault_state()
    total = idle + invested
    t = target_share(u, args.days_to_lease_end)
    want = int(total * t)
    delta = want - invested

    usdc = lambda x: f"{x / 1e7:,.2f} USDC"
    print(f"Blend utilization: {u:.1%}  (safe <= {U_SAFE:.0%}, stop >= {U_STOP:.0%})")
    if args.days_to_lease_end is not None:
        print(f"Next lease ends in {args.days_to_lease_end:g} days (glide path <= {GLIDE_DAYS})")
    print(f"Reserve: total {usdc(total)} | idle {usdc(idle)} | in Blend {usdc(invested)}")
    print(f"Target in Blend: {t:.0%} -> {usdc(want)}")

    if abs(delta) < MIN_MOVE:
        print("Already on target: nothing to do.")
        return
    kind, amount = ("Invest", delta) if delta > 0 else ("Unwind", -delta)
    instructions = json.dumps([{kind: [STRATEGY, str(amount)]}])
    print(f"Plan: {kind} {usdc(amount)}")
    if not args.execute:
        print("Dry run. Re-run with --execute to send it.")
        return
    invoke(VAULT, "rebalance", "--caller", SOURCE, "--instructions", instructions, send=True)
    idle, invested = vault_state()
    print(f"Done. Reserve now: idle {usdc(idle)} | in Blend {usdc(invested)}")


if __name__ == "__main__":
    main()
