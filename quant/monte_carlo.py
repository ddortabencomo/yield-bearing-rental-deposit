"""
Quant layer: how much of a rental deposit can be invested in Blend?

A payout is *delayed* only if two things happen at settlement:
  1. the landlord's deduction D is larger than the liquid buffer c = 1 - w, and
  2. Blend can't return the invested funds that day (probability q).
Assuming independence:  P(shortfall) = P(D > c) * q  <=  eps
=> c* = quantile_{1 - eps/q}(D),  w* = min(1 - c*, 80%)   (a VaR-style rule)

Everything is a fraction of the deposit. All parameters are ASSUMPTIONS to be
calibrated with real data (agencies / residences for D, pool history for q).

Run:  python quant/monte_carlo.py
Out:  quant/curve.json (for the web app) and quant/curve.png (for the deck)
"""
import json
import math
from pathlib import Path

import numpy as np

# ---------------- assumptions ----------------
P_NO_DEDUCTION = 0.60  # share of leases that end with no deduction
MEDIAN_DEDUCTION = 0.12  # median deduction when there is one (12% of deposit)
SIGMA = 0.85  # log-normal dispersion of the deduction tail
EPS = 0.005  # accepted probability of a delayed payout (0.5%)
SUPPLY_APR = 0.05  # assumed Blend USDC supply APR (check live rate before quoting)
LEASE_YEARS = 1.0
MAX_INVEST = 0.80  # hard cap enforced on-chain
SCENARIOS = {
    "no_unwind": 0.25,  # q: Blend illiquid on settlement day, no early exit
    "with_unwind": 0.02,  # q with unwind() during the last 30 days of the lease
}
N = 2_000_000
SEED = 7
# ---------------------------------------------


def sample_deductions(rng: np.random.Generator, n: int) -> np.ndarray:
    has = rng.random(n) >= P_NO_DEDUCTION
    tail = MEDIAN_DEDUCTION * np.exp(SIGMA * rng.standard_normal(n))
    return np.where(has, np.minimum(tail, 1.0), 0.0)


def p_exceed_exact(c: float) -> float:
    """P(D > c) in closed form, to cross-check the simulation."""
    if c >= 1.0:
        return 0.0
    z = (math.log(c) - math.log(MEDIAN_DEDUCTION)) / SIGMA if c > 0 else -math.inf
    return (1 - P_NO_DEDUCTION) * 0.5 * math.erfc(z / math.sqrt(2))


def main() -> None:
    rng = np.random.default_rng(SEED)
    d = sample_deductions(rng, N)
    out = {
        "assumptions": {
            "p_no_deduction": P_NO_DEDUCTION,
            "median_deduction": MEDIAN_DEDUCTION,
            "sigma": SIGMA,
            "eps": EPS,
            "supply_apr": SUPPLY_APR,
            "lease_years": LEASE_YEARS,
            "max_invest": MAX_INVEST,
            "n_sims": N,
        },
        "scenarios": {},
    }

    grid = [round(x, 2) for x in np.arange(0.0, MAX_INVEST + 1e-9, 0.05)]
    for name, q in SCENARIOS.items():
        # Each simulated lease also draws whether Blend is illiquid that day
        illiquid = rng.random(N) < q
        curve = []
        for w in grid:
            c = 1 - w
            short = (d > c) & illiquid
            curve.append(
                {
                    "invest_bps": int(round(w * 10_000)),
                    "shortfall_prob": float(short.mean()),
                    "shortfall_prob_exact": p_exceed_exact(c) * q,
                    "expected_yield": w * SUPPLY_APR * LEASE_YEARS,
                }
            )
        ok = [p for p in curve if p["shortfall_prob_exact"] <= EPS]
        rec = max(ok, key=lambda p: p["invest_bps"]) if ok else curve[0]

        # Unrounded optimum from the quantile rule
        target_tail = EPS / q / (1 - P_NO_DEDUCTION)  # P(L > c) needed
        if target_tail >= 1:
            w_star = MAX_INVEST
        else:
            from statistics import NormalDist

            z = NormalDist().inv_cdf(1 - target_tail)
            c_star = MEDIAN_DEDUCTION * math.exp(SIGMA * z)
            w_star = min(max(1 - c_star, 0.0), MAX_INVEST)

        out["scenarios"][name] = {
            "q": q,
            "optimal_invest": w_star,
            "recommended_bps": rec["invest_bps"],
            "curve": curve,
        }
        print(f"\n== {name} (q = {q:.0%}) ==")
        print(f"optimal invest share (quantile rule): {w_star:.1%}")
        print(f"recommended on 5% grid: {rec['invest_bps'] / 100:.0f}%")
        print(" invest | P(delay) sim | P(delay) exact | exp. yield")
        for p in curve:
            print(
                f"  {p['invest_bps'] / 100:4.0f}% | {p['shortfall_prob']:11.4%} |"
                f" {p['shortfall_prob_exact']:13.4%} | {p['expected_yield']:.2%}"
            )

    here = Path(__file__).parent
    (here / "curve.json").write_text(json.dumps(out, indent=2))
    print(f"\nwrote {here / 'curve.json'}")

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(figsize=(7, 4))
        for name, s in out["scenarios"].items():
            pts = [p for p in s["curve"] if p["invest_bps"] > 0]  # log scale: skip 0
            xs = [p["invest_bps"] / 100 for p in pts]
            ys = [p["shortfall_prob_exact"] * 100 for p in pts]
            label = f"{'with' if name == 'with_unwind' else 'no'} early unwind (q={s['q']:.0%})"
            ax.plot(xs, ys, marker="o", label=label)
        ax.axhline(EPS * 100, ls="--", c="grey", label=f"risk limit ε = {EPS:.1%}")
        ax.set_xlabel("Share of deposit invested in Blend (%)")
        ax.set_ylabel("P(delayed payout) (%)")
        ax.set_yscale("log")
        ax.set_title("How much of the deposit can safely earn yield?")
        ax.legend()
        fig.tight_layout()
        fig.savefig(here / "curve.png", dpi=200)
        print(f"wrote {here / 'curve.png'}")
    except ImportError:
        print("(matplotlib not installed: skipped the plot)")


if __name__ == "__main__":
    main()
