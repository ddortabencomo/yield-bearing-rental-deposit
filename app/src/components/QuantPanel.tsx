import { useEffect, useState } from "react"
import curve from "../lib/quant-curve.json"
import { getSupplyRates, MAX_INVEST_BPS, type PoolRates } from "../lib/rental"
import styles from "./QuantPanel.module.css"

/**
 * Quant layer: how much of the deposit can safely earn yield?
 * Data: quant/monte_carlo.py (2M simulated leases, cross-checked with the closed form).
 * A payout is only delayed if the deduction exceeds the liquid buffer AND Blend is
 * illiquid that day:  P = P(D > 1 - w) * q.  The contract has early unwind, so q is low.
 */
type Point = { invest_bps: number; shortfall_prob_exact: number }
const scenario = curve.scenarios.with_unwind
const noUnwind = curve.scenarios.no_unwind
const EPS = curve.assumptions.eps

const probAt = (pts: Point[], bps: number) =>
	pts.reduce((best, p) =>
		Math.abs(p.invest_bps - bps) < Math.abs(best.invest_bps - bps) ? p : best,
	).shortfall_prob_exact

const pct = (x: number, digits = 2) => `${(x * 100).toFixed(digits)}%`

export const QuantPanel = ({
	amount,
	investPct,
	onInvestPct,
	leaseDays,
	symbol,
	readOnly = false,
}: {
	amount: bigint
	investPct: number
	onInvestPct: (pct: number) => void
	leaseDays: number
	symbol: string
	readOnly?: boolean
}) => {
	const [rates, setRates] = useState<PoolRates | null>(null)
	const [open, setOpen] = useState(false)

	useEffect(() => {
		getSupplyRates()
			.then(setRates)
			.catch((e) => console.error("rates:", e))
	}, [])

	const recommended = Math.min(scenario.recommended_bps, MAX_INVEST_BPS) / 100
	const prob = probAt(scenario.curve, investPct * 100)
	const probNo = probAt(noUnwind.curve, investPct * 100)
	const ok = prob <= EPS

	const invested = (Number(amount) / 1e7) * (investPct / 100)
	const years = Math.max(leaseDays, 1) / 365
	const expected = rates ? invested * rates.supplyApr * years : null

	return (
		<div className={styles.panel}>
			<div className={styles.head}>
				<span className={styles.badge}>Risk model</span>
				<span>
					Recommended: <strong>{recommended}% invested</strong>
				</span>
				{!readOnly && investPct !== recommended && (
					<button type="button" onClick={() => onInvestPct(recommended)}>
						Apply
					</button>
				)}
			</div>

			<div className={styles.grid}>
				<div>
					<span className={styles.label}>Chance of a delayed payout</span>
					<strong className={ok ? styles.good : styles.bad}>{pct(prob, 3)}</strong>
					<span className={styles.note}>
						limit {pct(EPS, 1)} · without early unwind: {pct(probNo, 2)}
					</span>
				</div>
				<div>
					<span className={styles.label}>Expected yield over the lease</span>
					<strong className={styles.good}>
						{expected === null ? "…" : `+${expected.toFixed(2)} ${symbol}`}
					</strong>
					<span className={styles.note}>
						{rates
							? `Blend supply APR ${pct(rates.supplyApr)} · ${pct(rates.utilization, 0)} of the pool is borrowed`
							: "reading live rates from Blend…"}
					</span>
				</div>
			</div>

			<button type="button" className={styles.link} onClick={() => setOpen(!open)}>
				{open ? "Hide" : "How we compute this"}
			</button>
			{open && (
				<div className={styles.how}>
					<p>
						A payout is only delayed if two things happen at once: the deduction is
						larger than the liquid buffer, <em>and</em> Blend can&apos;t return funds
						that day. So <code>P(delay) = P(D &gt; 1 − w) · q ≤ ε</code>.
					</p>
					<p>
						The buffer is a quantile of the deduction distribution, like Value at
						Risk. Early unwind (any time in the last 30 days) cuts q from{" "}
						{pct(noUnwind.q, 0)} to {pct(scenario.q, 0)}, which raises the safe
						share from {Math.round(noUnwind.optimal_invest * 100)}% to{" "}
						{Math.round(scenario.optimal_invest * 100)}%. The contract caps it at 80%.
					</p>
					<p className={styles.note}>
						Assumptions to calibrate with real data: {pct(curve.assumptions.p_no_deduction, 0)} of
						leases end with no deduction; otherwise log-normal with median{" "}
						{pct(curve.assumptions.median_deduction, 0)} of the deposit. Monte Carlo
						with {(curve.assumptions.n_sims / 1e6).toFixed(0)}M leases, matching the
						closed form.
					</p>
				</div>
			)}
		</div>
	)
}
