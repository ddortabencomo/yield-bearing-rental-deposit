/**
 * Quant layer, part 3: where should the invested part go?
 *
 * Blend direct earns Blend's full supply rate, but this agreement's payout depends on the
 * pool being able to return funds that day. The DeFindex reserve is shared: part of it sits
 * idle and our rebalancer (quant/rebalance.py) pulls it out of Blend when the pool gets
 * crowded or a move-out is near, at the cost of a 1% fee and some idle money.
 *
 * So the recommendation uses the same utilization bands as the rebalancer:
 *   U <= 85%            → 20% DeFindex (mostly Blend direct: best yield, low liquidity risk)
 *   85% < U < 94%       → linearly up to 100% DeFindex
 *   U >= 94%, or the lease ends within 30 days → 100% DeFindex (liquidity first)
 */
export const U_SAFE = 0.85
export const U_STOP = 0.94
export const BASE_DEFINDEX_PCT = 20

export const recommendDefindexPct = (utilization: number, daysLeft: number): number => {
	if (daysLeft <= 30 || utilization >= U_STOP) return 100
	if (utilization <= U_SAFE) return BASE_DEFINDEX_PCT
	const t = (utilization - U_SAFE) / (U_STOP - U_SAFE)
	return Math.round((BASE_DEFINDEX_PCT + t * (100 - BASE_DEFINDEX_PCT)) / 10) * 10
}

export const splitReason = (utilization: number, daysLeft: number): string => {
	const u = `${Math.round(utilization * 100)}%`
	if (daysLeft <= 30) return "The lease ends within 30 days: liquidity first, so the managed reserve."
	if (utilization >= U_STOP) return `Blend is ${u} borrowed: too crowded to hold a direct position.`
	if (utilization <= U_SAFE)
		return `Blend is ${u} borrowed, comfortably liquid: mostly direct for the full rate.`
	return `Blend is ${u} borrowed: the busier the pool, the more goes to the reserve our model de-risks.`
}
