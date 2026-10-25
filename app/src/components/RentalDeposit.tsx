import { errorMessage, networkPassphrase, rpcUrl } from "@stellar-scaffold/app-lib"
import { contract } from "@stellar/stellar-sdk"
import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useWallet } from "../hooks/useWallet"
import { QuantPanel } from "./QuantPanel"
import {
	BLEND_POOL,
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
	type Position,
	toUnits,
	TOKEN,
	TOKEN_SYMBOL,
	symbolOf,
	UNWIND_WINDOW_SECS,
	WASM_HASH,
} from "../lib/rental"
import styles from "./RentalDeposit.module.css"

const STEPS = ["Fund", "Earn", "Propose", "Settle"] as const

const stepIndex = (d: Deposit | null): number => {
	if (!d) return 0
	switch (d.state) {
		case "Funded":
			return 1
		case "DeductionProposed":
		case "Disputed":
			return 3
		case "Closed":
			return 4
	}
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

export const RentalDeposit = () => {
	const { address, signTransaction, updateBalances } = useWallet()
	const [params, setParams] = useSearchParams()
	const contractId = params.get("id") || DEFAULT_CONTRACT

	const [deposit, setDeposit] = useState<Deposit | null>(null)
	const [position, setPosition] = useState<Position | null>(null)
	const [liquid, setLiquid] = useState<bigint>(0n)
	const [loading, setLoading] = useState(true)
	const [busy, setBusy] = useState<string>()
	const [error, setError] = useState<string>()
	const [lastTx, setLastTx] = useState<{ label: string; hash?: string }>()

	// form state
	const [landlord, setLandlord] = useState("")
	const [amount, setAmount] = useState("100")
	const [investPct, setInvestPct] = useState(70)
	const [leaseDays, setLeaseDays] = useState("7")
	const [deduction, setDeduction] = useState("12")
	const [evidence, setEvidence] = useState("ipfs://inspection-photos")

	const refresh = useCallback(async () => {
		const d = await getDeposit(contractId)
		setDeposit(d)
		if (d && d.state === "Closed") setLiquid(0n) // everything was paid out
		if (d && d.state !== "Closed") {
			if (d.in_blend) {
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
		if (!deposit || !deposit.in_blend) return
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

	const newAgreement = async () => {
		if (!address) {
			setError("Connect your wallet first.")
			return
		}
		setBusy("Creating agreement")
		setError(undefined)
		try {
			const tx = await contract.Client.deploy(null, {
				wasmHash: WASM_HASH,
				publicKey: address,
				signTransaction,
				rpcUrl,
				networkPassphrase,
			})
			const sent = await tx.signAndSend()
			const client = sent.result as contract.Client
			setParams({ id: client.options.contractId })
			setLastTx({
				label: "Agreement created",
				hash: sent.sendTransactionResponse?.hash,
			})
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
	const investedValue = deposit?.in_blend
		? (position?.value ?? deposit.invested)
		: 0n
	const totalNow = buffer + investedValue
	const accrued =
		deposit && deposit.state !== "Closed"
			? totalNow > deposit.amount
				? totalNow - deposit.amount
				: 0n
			: deposit
				? deposit.paid_landlord + deposit.paid_tenant - deposit.amount
				: 0n
	const now = Math.floor(Date.now() / 1000)
	const canUnwind =
		!!deposit &&
		deposit.in_blend &&
		deposit.state !== "Closed" &&
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
	const fundInvested = (fundUnits * BigInt(investPct * 100)) / 10000n

	const current = stepIndex(deposit)
	const sym = deposit ? symbolOf(deposit.token) : TOKEN_SYMBOL

	return (
		<div className={styles.wrap}>
			{/* Agreement bar */}
			<div className={styles.agreementBar}>
				<div>
					<span className={styles.label}>Agreement</span>{" "}
					<a href={explorerContract(contractId)} target="_blank" rel="noreferrer">
						<code>{short(contractId)}</code>
					</a>
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
				/* ---------- Not funded: tenant funds ---------- */
				<div className="card">
					<h2>Lock the deposit</h2>
					<p className={styles.muted}>
						The tenant deposits into this neutral contract. Neither party can
						withdraw on their own. Up to 80% earns yield in Blend; the rest
						stays liquid to pay deductions instantly.
					</p>
					<label className={styles.field}>
						Landlord address
						<input
							value={landlord}
							onChange={(e) => setLandlord(e.target.value.trim())}
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
					<label className={styles.field}>
						Invested in Blend: <strong>{investPct}%</strong>
						<input
							type="range"
							min={0}
							max={MAX_INVEST_BPS / 100}
							step={5}
							value={investPct}
							onChange={(e) => setInvestPct(Number(e.target.value))}
						/>
					</label>
					<div className={styles.split}>
						<div style={{ flex: Math.max(investPct, 1) }} className={styles.splitInvest}>
							{fromUnits(fundInvested)} earning yield
						</div>
						<div style={{ flex: Math.max(100 - investPct, 1) }} className={styles.splitBuffer}>
							{fromUnits(fundUnits - fundInvested)} liquid buffer
						</div>
					</div>
					<QuantPanel
						amount={fundUnits}
						investPct={investPct}
						onInvestPct={setInvestPct}
						leaseDays={Number(leaseDays) || 1}
						symbol={sym}
					/>
					<button
						className={styles.primary}
						disabled={!!busy || !address || !landlord || fundUnits <= 0n}
						onClick={() =>
							void run("Deposit locked", async () => {
								// The landlord must be able to receive the token, or settlement would fail
								try {
									await getBalance(landlord, TOKEN)
								} catch {
									throw new Error(
										`The landlord's wallet can't receive ${sym} yet (no trustline). Ask them to add ${sym} first.`,
									)
								}
								return build(
									contractId,
									"fund",
									{
										tenant: address,
										landlord,
										arbiter: PLATFORM_ARBITER,
										token: TOKEN,
										pool: BLEND_POOL,
										amount: fundUnits,
										invest_bps: investPct * 100,
										lease_end: BigInt(
											Math.floor(Date.now() / 1000) +
												Math.max(1, Number(leaseDays) || 1) * 86_400,
										),
									},
									{ publicKey: address },
								)
							})
						}
					>
						{busy === "Deposit locked" ? "Signing…" : "Lock deposit"}
					</button>
					{!address && (
						<p className={styles.muted}>Connect the tenant&apos;s wallet to continue.</p>
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
							<span className={styles.label}>In Blend</span>
							<strong>
								{fromUnits(investedValue)} {sym}
							</strong>
							<span className={styles.muted}>
								{deposit.in_blend
									? `${deposit.invest_bps / 100}% invested`
									: deposit.invested > 0n
										? "withdrawn from Blend"
										: "not invested"}
								{position ? ` · ${position.bTokens.toLocaleString()} bTokens` : ""}
							</span>
						</div>
						<div className={styles.tile}>
							<span className={styles.label}>Liquid buffer</span>
							<strong>
								{fromUnits(buffer)} {sym}
							</strong>
							<span className={styles.muted}>
								{deposit.state === "Closed"
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
										? "live from Blend · updates every 8 s"
										: "withdrawn, waiting for settlement"}
							</span>
						</div>
					</div>

					{/* ---------- Waterfall ---------- */}
					{deposit.state !== "Closed" && (
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
								Accepting withdraws everything from Blend and pays out with the
								waterfall in one transaction.
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
					<h3 className={styles.h3}>Lease ends soon: move funds out of Blend</h3>
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
						Unwind from Blend
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
