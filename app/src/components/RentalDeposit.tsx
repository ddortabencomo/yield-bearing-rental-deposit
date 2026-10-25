import { errorMessage } from "@stellar-scaffold/app-lib"
import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useWallet } from "../hooks/useWallet"
import { QuantPanel } from "./QuantPanel"
import {
	BLEND_POOL,
	createAgreement,
	DEFINDEX_VAULT,
	getVaultPosition,
	getReserveState,
	DEFAULT_CONTRACT,
	type Deposit,
	explorerContract,
	explorerTx,
	fromUnits,
	getBalance,
	getDeposit,
	getPosition,
	invoke,
	type Signer,
	MAX_INVEST_BPS,
	PLATFORM_ARBITER,
	ASSETS,
	type Position,
	toUnits,
	TOKEN,
	TOKEN_SYMBOL,
	symbolOf,
	UNWIND_WINDOW_SECS,
} from "../lib/rental"
import styles from "./RentalDeposit.module.css"

const STEPS = ["Agree", "Earn", "Propose", "Settle"] as const

const stepIndex = (d: Deposit | null): number => {
	if (!d) return 0
	switch (d.state) {
		case "Offered":
			return 0
		case "Funded":
			return 1
		case "DeductionProposed":
		case "Disputed":
		case "Settling":
			return 3
		case "Closed":
			return 4
	}
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

export const RentalDeposit = () => {
	const { address, signTransaction, updateBalances } = useWallet()
	const [params, setParams] = useSearchParams()
	const creating = params.get("new") === "1"
	const contractId = params.get("id") || (creating ? "" : DEFAULT_CONTRACT)

	const [deposit, setDeposit] = useState<Deposit | null>(null)
	const [position, setPosition] = useState<Position | null>(null)
	const [vaultPos, setVaultPos] = useState<{ shares: bigint; value: bigint } | null>(null)
	const [reserve, setReserve] = useState<{ idle: bigint; invested: bigint } | null>(null)
	const [liquid, setLiquid] = useState<bigint>(0n)
	const [loading, setLoading] = useState(true)
	const [busy, setBusy] = useState<string>()
	const [error, setError] = useState<string>()
	const [lastTx, setLastTx] = useState<{ label: string; hash?: string }>()

	// form state
	const [tenant, setTenant] = useState("")
	const [amount, setAmount] = useState("100")
	const investPct = 70 // landlord's default only; the tenant picks the invested share when locking
	const [tenantInvestPct, setTenantInvestPct] = useState(70)
	const defindexPct = 50 // landlord's default only; the tenant picks the split when locking
	const [tenantDfxPct, setTenantDfxPct] = useState(50)
	const [leaseDays, setLeaseDays] = useState("7")
	const [deduction, setDeduction] = useState("12")
	const [evidence, setEvidence] = useState("ipfs://inspection-photos")

	const refresh = useCallback(async () => {
		if (!contractId) {
			// New agreement: nothing on-chain yet, show the landlord's form
			setDeposit(null)
			setPosition(null)
			setLoading(false)
			return
		}
		const d = await getDeposit(contractId)
		setDeposit(d)
		const active =
			d &&
			(d.state === "Funded" || d.state === "DeductionProposed" || d.state === "Disputed")
		if (d && !active) setLiquid(0n) // not funded yet, or the buffer was already paid out
		if (d && active) {
			if (d.in_blend || d.in_vault) {
				// While invested, the contract holds exactly the buffer (enforced on-chain)
				setLiquid(d.amount - d.invested)
			} else {
				// After unwind (or 0% invested) everything, yield included, is in the contract
				let bal = d.amount - d.invested
				try {
					const b = await getBalance(contractId, d.token)
					if (b > 0n) bal = b
				} catch (e) {
					console.error("balance:", e)
				}
				setLiquid(bal)
			}
		}
		if (d && d.in_blend) {
			try {
				setPosition(await getPosition(contractId, d.pool, d.token))
			} catch (e) {
				console.error("position:", e)
			}
		} else {
			setPosition(null)
		}
		if (d && d.in_vault) {
			try {
				setVaultPos(await getVaultPosition(contractId, d.vault))
				setReserve(await getReserveState(d.vault))
			} catch (e) {
				console.error("vault position:", e)
			}
		} else {
			setVaultPos(null)
		}
		setLoading(false)
	}, [contractId])

	useEffect(() => {
		setLoading(true)
		setLastTx(undefined)
		setError(undefined)
		void refresh()
	}, [refresh])

	// Live yield: re-read the Blend position every 8 s while funds are invested
	useEffect(() => {
		if (!deposit || !(deposit.in_blend || deposit.in_vault)) return
		const t = setInterval(() => void refresh(), 8000)
		return () => clearInterval(t)
	}, [deposit, refresh])

	/** Describe a contract call (sent by `run`). */
	const build = (
		id: string,
		method: string,
		args?: Record<string, unknown>,
		_opts?: unknown,
	) => Promise.resolve({ id, method, args })

	/** Sign with the connected wallet, submit, then refresh. */
	const run = async (
		label: string,
		make: () => Promise<{
			id: string
			method: string
			args?: Record<string, unknown>
		}>,
	) => {
		if (!address) {
			setError("Connect your wallet first.")
			return
		}
		setBusy(label)
		setError(undefined)
		try {
			const c = await make()
			const hash = await invoke(
				c.id,
				c.method,
				c.args,
				address,
				signTransaction as unknown as Signer,
			)
			setLastTx({ label, hash })
			await refresh()
			await updateBalances()
		} catch (e) {
			console.error(e)
			setError(errorMessage(e))
		} finally {
			setBusy(undefined)
		}
	}

	/** Open the landlord's form for a new agreement (nothing is deployed yet). */
	const newAgreement = () => {
		setError(undefined)
		setLastTx(undefined)
		setParams({ new: "1" })
	}

	/** Landlord: deploy a new agreement with its terms in one transaction. */
	const offerTerms = async () => {
		if (!address) {
			setError("Connect your wallet first.")
			return
		}
		setBusy("Terms offered")
		setError(undefined)
		try {
			// The landlord must be able to receive the token, or settlement would fail
			try {
				await getBalance(address, TOKEN)
			} catch {
				throw new Error(
					`Your wallet can't receive ${sym} yet (no trustline). Add ${sym} to your wallet first.`,
				)
			}
			const { id, hash } = await createAgreement(
				{
					landlord: address,
					tenant,
					arbiter: PLATFORM_ARBITER,
					token: TOKEN,
					pool: BLEND_POOL,
					vault: DEFINDEX_VAULT,
					amount: fundUnits,
					invest_bps: investPct * 100,
					defindex_bps: defindexPct * 100,
					lease_end: BigInt(
						Math.floor(Date.now() / 1000) + Math.max(1, Number(leaseDays) || 1) * 86_400,
					),
				},
				address,
				signTransaction as unknown as Signer,
			)
			setParams({ id })
			setLastTx({ label: "Agreement created and terms offered", hash })
			await updateBalances()
		} catch (e) {
			console.error(e)
			setError(errorMessage(e))
		} finally {
			setBusy(undefined)
		}
	}

	// ---------- derived numbers ----------
	const role =
		deposit && address
			? address === deposit.tenant
				? "Tenant"
				: address === deposit.landlord
					? "Landlord"
					: "Viewer"
			: undefined

	// liquid = what the contract holds right now; investedValue = live Blend position
	const buffer = liquid
	const vaultInvested = deposit
		? (deposit.invested * BigInt(deposit.defindex_bps)) / 10000n
		: 0n
	const blendValue = deposit?.in_blend
		? (position?.value ?? deposit.invested - vaultInvested)
		: 0n
	const vaultValue = deposit?.in_vault ? (vaultPos?.value ?? vaultInvested) : 0n
	const investedValue = blendValue + vaultValue
	const totalNow = buffer + investedValue
	const paidSoFar = deposit ? deposit.paid_landlord + deposit.paid_tenant : 0n
	const grossNow = totalNow + paidSoFar // everything the deposit is worth, paid or not
	const accrued =
		deposit && deposit.state !== "Offered" && grossNow > deposit.amount
			? grossNow - deposit.amount
			: 0n
	const cancelled = deposit?.state === "Closed" && paidSoFar === 0n
	const live =
		!!deposit &&
		(deposit.state === "Funded" ||
			deposit.state === "DeductionProposed" ||
			deposit.state === "Disputed")
	const now = Math.floor(Date.now() / 1000)
	const canUnwind =
		!!deposit &&
		(deposit.in_blend || deposit.in_vault) &&
		live &&
		now + UNWIND_WINDOW_SECS >= deposit.lease_end
	const toLandlord = deposit
		? deposit.deduction < totalNow
			? deposit.deduction
			: totalNow
		: 0n
	const toTenant = totalNow - toLandlord

	const fundUnits = (() => {
		try {
			return toUnits(amount)
		} catch {
			return 0n
		}
	})()

	// The landlord picks the pool, token and arbiter: only accept the official Blend pool,
	// supported assets and the platform's arbiter (the contract can't judge who is neutral)
	const trustedTerms =
		!!deposit &&
		deposit.pool === BLEND_POOL &&
		deposit.vault === DEFINDEX_VAULT &&
		deposit.arbiter === PLATFORM_ARBITER &&
		(Object.values(ASSETS) as string[]).includes(deposit.token)
	const current = stepIndex(deposit)
	const sym = deposit ? symbolOf(deposit.token) : TOKEN_SYMBOL

	return (
		<div className={styles.wrap}>
			{/* Agreement bar */}
			<div className={styles.agreementBar}>
				<div>
					<span className={styles.label}>Agreement</span>{" "}
					{contractId ? (
						<a href={explorerContract(contractId)} target="_blank" rel="noreferrer">
							<code>{short(contractId)}</code>
						</a>
					) : (
						<code>new</code>
					)}
					{role && <span className={styles.role}>You: {role}</span>}
				</div>
				<button onClick={() => void newAgreement()} disabled={!!busy}>
					+ New agreement
				</button>
			</div>

			{/* Stepper */}
			<ol className={styles.steps}>
				{STEPS.map((s, i) => (
					<li
						key={s}
						className={
							i < current ? styles.done : i === current ? styles.active : ""
						}
					>
						<span className={styles.dot}>{i < current ? "✓" : i + 1}</span>
						{s}
					</li>
				))}
			</ol>

			{loading ? (
				<div className="card">Loading agreement…</div>
			) : !deposit ? (
				/* ---------- New agreement: the landlord offers the terms ---------- */
				<div className="card">
					<h2>Offer the terms</h2>
					<p className={styles.muted}>
						The landlord proposes the agreement; the tenant accepts it by depositing.
						The deposit is held by this neutral contract: neither party can take it
						alone. Up to 80% earns yield in Blend; the rest stays liquid to pay
						deductions instantly.
					</p>
					<label className={styles.field}>
						Tenant address
						<input
							value={tenant}
							onChange={(e) => setTenant(e.target.value.trim())}
							placeholder="G..."
						/>
					</label>
					<label className={styles.field}>
						Deposit ({sym})
						<input
							type="number"
							min="0"
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
						/>
					</label>
					<label className={styles.field}>
						Lease ends in (days)
						<input
							type="number"
							min="1"
							value={leaseDays}
							onChange={(e) => setLeaseDays(e.target.value)}
						/>
					</label>
					<p className={styles.muted}>
						Your tenant chooses how much of the deposit earns yield (never above 80%), so at
						least 20% always stays liquid to pay your deduction on the spot.
					</p>
					<p className={styles.muted}>
						Disputes are decided by a neutral arbiter ({short(PLATFORM_ARBITER)}).
					</p>
					<button
						className={styles.primary}
						disabled={!!busy || !address || !tenant || fundUnits <= 0n}
						onClick={() => void offerTerms()}
					>
						{busy === "Terms offered" ? "Signing…" : "Offer terms to the tenant"}
					</button>
					{!address && (
						<p className={styles.muted}>Connect the landlord&apos;s wallet to continue.</p>
					)}
				</div>
			) : deposit.state === "Offered" || cancelled ? (
				/* ---------- Offered: the tenant reviews and accepts by depositing ---------- */
				<div className="card">
					{cancelled ? (
						<>
							<h2>Offer cancelled</h2>
							<p className={styles.muted}>
								The landlord withdrew this offer before it was funded. No money moved.
							</p>
						</>
					) : (
						<>
							<h2>
								Terms offered: {fromUnits(deposit.amount)} {sym} deposit
							</h2>
							<div className={styles.waterfall}>
								<div>
									Landlord<strong>{short(deposit.landlord)}</strong>
								</div>
								<div>
									Tenant<strong>{short(deposit.tenant)}</strong>
								</div>
								<div>
									Invested<strong>
										{role === "Tenant" ? `${tenantInvestPct}% (your choice)` : "chosen by the tenant"}
									</strong>
								</div>
								<div>
									Lease ends
									<strong>{new Date(deposit.lease_end * 1000).toLocaleDateString()}</strong>
								</div>
								<div>
									Neutral arbiter<strong>{short(deposit.arbiter)}</strong>
								</div>
							</div>
							{role === "Tenant" && (
								<label className={styles.field}>
									Your choice: how much of your deposit earns yield:{" "}
									<strong>{tenantInvestPct}%</strong>
									<input
										type="range"
										min={0}
										max={MAX_INVEST_BPS / 100}
										step={5}
										value={tenantInvestPct}
										onChange={(e) => setTenantInvestPct(Number(e.target.value))}
									/>
									<span className={styles.muted}>
										Never above 80%: at least 20% always stays liquid for the landlord&apos;s
										deduction. Our risk model below recommends a share.
									</span>
								</label>
							)}
							<QuantPanel
								amount={deposit.amount}
								investPct={role === "Tenant" ? tenantInvestPct : deposit.invest_bps / 100}
								onInvestPct={setTenantInvestPct}
								leaseDays={Math.max(1, Math.round((deposit.lease_end - now) / 86_400))}
								symbol={sym}
								readOnly={role !== "Tenant"}
							/>
							{role === "Tenant" && (
								<label className={styles.field}>
									Your choice: where your invested part earns yield:{" "}
									<strong>
										{100 - tenantDfxPct}% Blend direct · {tenantDfxPct}% DeFindex reserve
									</strong>
									<input
										type="range"
										min={0}
										max={100}
										step={10}
										value={tenantDfxPct}
										onChange={(e) => setTenantDfxPct(Number(e.target.value))}
									/>
									<span className={styles.muted}>
										The yield is yours, so this is your call. Blend direct: this agreement
										holds its own position. DeFindex reserve: a shared vault whose exposure
										to Blend our risk model adjusts to pool liquidity and upcoming move-outs.
									</span>
								</label>
							)}
							{!trustedTerms && (
								<div className={`card ${styles.err}`} role="alert">
									Warning: this agreement does not use the official Blend pool, a
									supported token or the platform&apos;s neutral arbiter. Do not
									deposit.
								</div>
							)}
							{role === "Tenant" ? (
								<button
									className={styles.primary}
									disabled={!!busy || !trustedTerms}
									onClick={() =>
										void run("Deposit locked", () =>
											build(contractId, "fund", {
												landlord: deposit.landlord,
												arbiter: deposit.arbiter,
												token: deposit.token,
												pool: deposit.pool,
												vault: deposit.vault,
												amount: deposit.amount,
												invest_bps: tenantInvestPct * 100,
												defindex_bps: tenantDfxPct * 100,
												lease_end: BigInt(deposit.lease_end),
											}),
										)
									}
								>
									{busy === "Deposit locked" ? "Signing…" : "Accept terms & lock deposit"}
								</button>
							) : role === "Landlord" ? (
								<>
									<p className={styles.muted}>
										Waiting for your tenant to accept. Send them this page&apos;s
										link:
									</p>
									<p>
										<code>{window.location.href}</code>
									</p>
									<button
										disabled={!!busy}
										onClick={() => void run("Offer cancelled", () => build(contractId, "cancel_offer"))}
									>
										Cancel offer
									</button>
								</>
							) : (
								<p className={styles.muted}>
									Waiting for the tenant ({short(deposit.tenant)}) to accept. Connect
									the tenant&apos;s wallet to continue.
								</p>
							)}
						</>
					)}
				</div>
			) : (
				<>
					{/* ---------- Status ---------- */}
					<div className={styles.tiles}>
						<div className={styles.tile}>
							<span className={styles.label}>Deposit</span>
							<strong>
								{fromUnits(deposit.amount)} {sym}
							</strong>
							<span className={styles.muted}>
								{short(deposit.tenant)} → {short(deposit.landlord)}
							</span>
						</div>
						<div className={styles.tile}>
							<span className={styles.label}>Invested</span>
							<strong>
								{fromUnits(investedValue)} {sym}
							</strong>
							<span className={styles.muted}>
								{deposit.in_blend || deposit.in_vault
									? `Blend ${fromUnits(blendValue)} · DeFindex ${fromUnits(vaultValue)}${
											reserve && reserve.idle + reserve.invested > 0n
												? ` (reserve ${Number((reserve.invested * 100n) / (reserve.idle + reserve.invested))}% in Blend, rest ready)`
												: ""
										}`
									: deposit.invested > 0n
										? "withdrawn from Blend and DeFindex"
										: "not invested"}
							</span>
						</div>
						<div className={styles.tile}>
							<span className={styles.label}>Liquid buffer</span>
							<strong>
								{fromUnits(buffer)} {sym}
							</strong>
							<span className={styles.muted}>
								{deposit.state === "Closed" || deposit.state === "Settling"
									? "paid out at settlement"
									: "held in the contract · pays deductions instantly"}
							</span>
						</div>
						<div className={`${styles.tile} ${styles.yieldTile}`}>
							<span className={styles.label}>Yield accrued</span>
							<strong>
								+{fromUnits(accrued, 7)} {sym}
							</strong>
							<span className={styles.muted}>
								{deposit.state === "Closed"
									? "paid to tenant"
									: deposit.in_blend
										? "live from Blend & DeFindex · updates every 8 s"
										: "withdrawn, waiting for settlement"}
							</span>
						</div>
					</div>

					{/* ---------- Allocation: where the deposit is right now ---------- */}
					{deposit.state !== "Offered" && deposit.state !== "Closed" && (() => {
						const pctInv = deposit.invest_bps / 100
						const pctVault = (deposit.invest_bps * deposit.defindex_bps) / 1_000_000
						const pctBlend = pctInv - pctVault
						const pctBuf = 100 - pctInv
						const fmt = (x: number) => `${Math.round(x * 10) / 10}%`
						const parts = [
							{ name: "Blend direct", pct: pctBlend, value: blendValue, cls: styles.splitInvest },
							{ name: "DeFindex reserve", pct: pctVault, value: vaultValue, cls: styles.splitVault },
							{ name: "Liquid buffer", pct: pctBuf, value: buffer, cls: styles.splitBuffer },
						]
						return (
							<div className="card">
								<h3 className={styles.h3}>Where the deposit is</h3>
								<div className={styles.split}>
									{parts
										.filter((x) => x.pct > 0)
										.map((x) => (
											<div key={x.name} style={{ flex: x.pct }} className={x.cls}>
												{fmt(x.pct)}
											</div>
										))}
								</div>
								<div className={styles.waterfall}>
									{parts.map((x) => (
										<div key={x.name}>
											{x.name} · {fmt(x.pct)}
											<strong>
												{fromUnits(x.value)} {sym}
											</strong>
										</div>
									))}
								</div>
								<p className={styles.muted}>
									Chosen by the tenant: {fmt(pctInv)} invested, split {fmt(100 - deposit.defindex_bps / 100)} Blend
									/ {fmt(deposit.defindex_bps / 100)} DeFindex. Percentages are of the whole deposit;
									amounts are live.
								</p>
							</div>
						)
					})()}

					{/* ---------- Waterfall ---------- */}
					{live && (
						<div className="card">
							<h3 className={styles.h3}>Payout if settled now</h3>
							<div className={styles.waterfall}>
								<div>
									<span className={styles.wfNum}>1</span> Landlord deduction
									<strong>
										{fromUnits(toLandlord, 7)} {sym}
									</strong>
								</div>
								<div>
									<span className={styles.wfNum}>2</span> Tenant: deposit −
									deduction + all yield
									<strong>
										{fromUnits(toTenant, 7)} {sym}
									</strong>
								</div>
							</div>
							{deposit.evidence && deposit.state !== "Funded" && (
								<p className={styles.muted}>
									Evidence: <code>{deposit.evidence}</code>
								</p>
							)}
						</div>
					)}

					{/* ---------- Actions by state & role ---------- */}
					{deposit.state === "Funded" && (
						<div className="card">
							<h2>End of lease: propose a deduction</h2>
							{role !== "Landlord" ? (
								<p className={styles.muted}>
									Waiting for the landlord ({short(deposit.landlord)}). Switch
									your wallet to the landlord&apos;s account to continue.
								</p>
							) : (
								<>
									<label className={styles.field}>
										Deduction ({sym}, max {fromUnits(deposit.amount)})
										<input
											type="number"
											min="0"
											value={deduction}
											onChange={(e) => setDeduction(e.target.value)}
										/>
									</label>
									<label className={styles.field}>
										Evidence (link or hash)
										<input
											value={evidence}
											onChange={(e) => setEvidence(e.target.value)}
										/>
									</label>
									<button
										className={styles.primary}
										disabled={!!busy}
										onClick={() =>
											void run("Deduction proposed", () =>
												build(
													contractId,
													"propose_deduction",
													{ deduction: toUnits(deduction), evidence },
													{ publicKey: address },
												),
											)
										}
									>
										{busy ? "Signing…" : "Propose deduction"}
									</button>
								</>
							)}
						</div>
					)}

					{deposit.state === "DeductionProposed" && (
						<div className="card">
							<h2>
								Landlord proposes {fromUnits(deposit.deduction)} {sym}
							</h2>
							{role !== "Tenant" ? (
								<p className={styles.muted}>
									Waiting for the tenant ({short(deposit.tenant)}) to accept or
									dispute.
								</p>
							) : (
								<div className={styles.actions}>
									<button
										className={styles.primary}
										disabled={!!busy}
										onClick={() =>
											void run("Released", () =>
												build(contractId, "accept_and_release", undefined, {
													publicKey: address,
												}),
											)
										}
									>
										{busy === "Released" ? "Signing…" : "Accept & release"}
									</button>
									<button
										disabled={!!busy}
										onClick={() =>
											void run("Disputed", () =>
												build(contractId, "dispute", undefined, {
													publicKey: address,
												}),
											)
										}
									>
										Dispute
									</button>
								</div>
							)}
							<p className={styles.muted}>
								Accepting pays out with the waterfall in one transaction. If Blend
								can&apos;t return its part that day, the liquid buffer still pays
								right away (landlord first) and the rest follows when liquidity is
								back.
							</p>
						</div>
					)}

					{deposit.state === "Disputed" && (
						<div className={`card ${styles.warn}`}>
							<h2>Disputed: payout frozen</h2>
							<p>
								Funds stay locked in the contract
								{deposit.in_blend ? " (and keep earning in Blend)" : ""} until the
								neutral arbiter ({short(deposit.arbiter)}) resolves the dispute. The
								arbiter can never award more than the landlord asked.
							</p>
						</div>
					)}

					{deposit.state === "Settling" && (
						<div className={`card ${styles.warn}`}>
							<h2>Partly paid out: waiting for Blend liquidity</h2>
							<p>
								The liquid buffer has been paid with the waterfall. Blend can&apos;t
								return the invested part right now (the pool is heavily borrowed),
								so it stays there, still earning, until anyone claims it.
							</p>
							<div className={styles.waterfall}>
								<div>
									<span className={styles.wfNum}>1</span> Landlord paid so far
									<strong>
										{fromUnits(deposit.paid_landlord, 7)} {sym}
										{deposit.owed_landlord > 0n
											? ` (still owed ${fromUnits(deposit.owed_landlord, 7)})`
											: ""}
									</strong>
								</div>
								<div>
									<span className={styles.wfNum}>2</span> Tenant paid so far
									<strong>
										{fromUnits(deposit.paid_tenant, 7)} {sym}
									</strong>
								</div>
							</div>
							<button
								disabled={!!busy}
								onClick={() =>
									void run("Remaining claimed", () => build(contractId, "claim_remaining"))
								}
							>
								Claim the rest from Blend
							</button>
						</div>
					)}

					{deposit.state === "Closed" && (
						<div className={`card ${styles.ok}`}>
							<h2>Settled</h2>
							<div className={styles.waterfall}>
								<div>
									<span className={styles.wfNum}>1</span> Landlord received
									<strong>
										{fromUnits(deposit.paid_landlord, 7)} {sym}
									</strong>
								</div>
								<div>
									<span className={styles.wfNum}>2</span> Tenant received
									(including +{fromUnits(accrued, 7)} yield)
									<strong>
										{fromUnits(deposit.paid_tenant, 7)} {sym}
									</strong>
								</div>
							</div>
						</div>
					)}
				</>
			)}

			{canUnwind && (
				<div className="card">
					<h3 className={styles.h3}>Lease ends soon: bring the money home</h3>
					<p className={styles.muted}>
						In the last 30 days anyone can unwind, so settlement never depends on
						the pool&apos;s liquidity that day.
					</p>
					<button
						disabled={!!busy}
						onClick={() =>
							void run("Unwound", () =>
								build(contractId, "unwind", undefined, { publicKey: address }),
							)
						}
					>
						Unwind from Blend & DeFindex
					</button>
				</div>
			)}

			{busy && <p className={styles.muted}>{busy}: confirm in your wallet…</p>}
			{error && (
				<div className={`card ${styles.err}`} role="alert">
					{error}
				</div>
			)}
			{lastTx?.hash && (
				<p className={styles.muted}>
					✓ {lastTx.label}:{" "}
					<a href={explorerTx(lastTx.hash)} target="_blank" rel="noreferrer">
						view transaction
					</a>
				</p>
			)}
		</div>
	)
}
