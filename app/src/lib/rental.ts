import {
	Account,
	Address,
	contract,
	BASE_FEE,
	Contract,
	Operation,
	rpc,
	scValToNative,
	Transaction,
	TransactionBuilder,
	xdr,
} from "@stellar/stellar-sdk"
import { networkPassphrase, rpcUrl } from "@stellar-scaffold/app-lib"

// ---------- Testnet configuration ----------

/** Blend v2 testnet pool (TestnetV2, from blend-capital/blend-utils testnet.contracts.json). */
export const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"
/** "Blendlord Deposit Reserve": our own DeFindex vault, created with the DeFindex factory.
 * Shared by all agreements. Its Rebalance Manager (quant/rebalance.py) moves funds between
 * idle liquidity and the DeFindex Blend USDC strategy based on Blend utilization and
 * upcoming move-outs. */
export const DEFINDEX_VAULT = "CDULNJ6EKQJJRPPZIGZ3R4T2W3DVTDFQTAMX3RBVV3RII5JJAXZQRDED"
/** Assets the deposit can be held in (Blend v2 testnet reserves). */
export const ASSETS = {
	USDC: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU", // Blend testnet USDC (needs a trustline)
	XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
} as const
/** Switch the whole app between USDC and XLM here. */
export const TOKEN_SYMBOL: keyof typeof ASSETS = "USDC"
export const TOKEN = ASSETS[TOKEN_SYMBOL]
/** Symbol for a token address (deposits keep the token they were funded with). */
export const symbolOf = (token: string) =>
	(Object.entries(ASSETS).find(([, id]) => id === token)?.[0] ?? "tokens") as string
export const DECIMALS = 7
/** RentalDeposit wasm already uploaded to testnet: new agreements are instances of it. */
export const WASM_HASH =
	"c0161a5e6678caf37b6dbd45e2261de34cb18711ed6bc1ecb767ad70dfc73db5"
/** Neutral arbiter for disputes (the platform). Demo: the `alice` CLI identity. */
export const PLATFORM_ARBITER =
	"GAKGQO3VCSGAVWNYI2KLT2MU2MDEHD2EHU4QASOOFRZPP7HFVCMAALJJ"
/** unwind() opens this many seconds before the lease ends (same as the contract). */
export const UNWIND_WINDOW_SECS = 30 * 86_400
/** Same cap the contract enforces on-chain. */
export const MAX_INVEST_BPS = 8000
/** Default instance (overridden by ?id=C... in the URL). */
export const DEFAULT_CONTRACT =
	"CAYD7CI37ASKCBKVPJ4XMEE6MLSRN6JNCAJ3H6DWWQ6ZCDOOQEJ34ERN"

export const explorerTx = (hash: string) =>
	`https://stellar.expert/explorer/testnet/tx/${hash}`
export const explorerContract = (id: string) =>
	`https://stellar.expert/explorer/testnet/contract/${id}`

// ---------- Amount helpers ----------

const UNIT = 10n ** BigInt(DECIMALS)

export const toUnits = (human: string): bigint => {
	const [whole = "0", frac = ""] = human.trim().split(".")
	const fracPadded = (frac + "0".repeat(DECIMALS)).slice(0, DECIMALS)
	return BigInt(whole || "0") * UNIT + BigInt(fracPadded || "0")
}

export const fromUnits = (units: bigint, digits = 2): string => {
	const neg = units < 0n
	const abs = neg ? -units : units
	const whole = abs / UNIT
	const frac = (abs % UNIT).toString().padStart(DECIMALS, "0").slice(0, digits)
	return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${digits > 0 ? "." + frac : ""}`
}

// ---------- Contract access ----------

type Method = (...a: unknown[]) => Promise<contract.AssembledTransaction<unknown>>
type Dynamic = Record<string, Method>

const clients = new Map<string, Promise<contract.Client>>()

/** Client built at runtime from the contract's on-chain spec (works for any instance id). */
export const getClient = (contractId: string) => {
	let c = clients.get(contractId)
	if (!c) {
		c = contract.Client.from({ contractId, rpcUrl, networkPassphrase })
		clients.set(contractId, c)
		c.catch(() => clients.delete(contractId))
	}
	return c
}

/** Build (and simulate) a call. Zero-argument methods take only the options. */
export const build = async (
	contractId: string,
	method: string,
	args?: Record<string, unknown>,
	opts: Record<string, unknown> = {},
) => {
	const c = (await getClient(contractId)) as unknown as Dynamic
	const fn = c[method]
	if (!fn) throw new Error(`Method ${method} not found on ${contractId}`)
	return args ? fn(args, opts) : fn(opts)
}

/** Read-only call: returns the simulated result. */
export const read = async <T>(
	contractId: string,
	method: string,
	args?: Record<string, unknown>,
): Promise<T> => {
	const tx = await build(contractId, method, args)
	return tx.result as T
}

// ---------- Deposit state ----------

export type StateName =
	| "Offered"
	| "Funded"
	| "DeductionProposed"
	| "Disputed"
	| "Settling"
	| "Closed"

export interface Deposit {
	tenant: string
	landlord: string
	arbiter: string
	token: string
	pool: string
	vault: string
	amount: bigint
	invest_bps: number
	defindex_bps: number
	landlord_yield_bps: number // landlord's share of the yield only (max 5%)
	invested: bigint
	in_blend: boolean
	in_vault: boolean
	lease_end: number // unix seconds
	deduction: bigint
	evidence: string
	proposed_at: number
	owed_landlord: bigint
	paid_landlord: bigint
	paid_tenant: bigint
	state: StateName
}

const stateName = (s: unknown): StateName =>
	(typeof s === "string" ? s : (s as { tag: string }).tag) as StateName

/** Returns null when the instance has not been funded yet (the contract panics "no deposit"). */
export const getDeposit = async (contractId: string): Promise<Deposit | null> => {
	try {
		const d = await read<Record<string, unknown>>(contractId, "get_deposit")
		return {
			...(d as unknown as Deposit),
			amount: BigInt(d.amount as bigint),
			invested: BigInt(d.invested as bigint),
			deduction: BigInt(d.deduction as bigint),
			owed_landlord: BigInt((d.owed_landlord as bigint) ?? 0n),
			paid_landlord: BigInt(d.paid_landlord as bigint),
			paid_tenant: BigInt(d.paid_tenant as bigint),
			lease_end: Number(d.lease_end),
			proposed_at: Number(d.proposed_at),
			in_blend: Boolean(d.in_blend),
			in_vault: Boolean(d.in_vault),
			defindex_bps: Number(d.defindex_bps ?? 0),
			landlord_yield_bps: Number(d.landlord_yield_bps ?? 0),
			invest_bps: Number(d.invest_bps),
			state: stateName(d.state),
		}
	} catch (e) {
		console.info("get_deposit:", e)
		return null
	}
}

// ---------- Blend position ----------

/** Map<u32, i128> comes back as [key, value] pairs; accept Map/object too. */
const mapGet = (m: unknown, key: number): bigint | undefined => {
	if (!m) return undefined
	if (Array.isArray(m)) {
		const hit = m.find(([k]) => Number(k) === key)
		return hit ? BigInt(hit[1]) : undefined
	}
	if (m instanceof Map) {
		const v = m.get(key) ?? m.get(String(key))
		return v === undefined ? undefined : BigInt(v)
	}
	const v = (m as Record<string, unknown>)[String(key)]
	return v === undefined ? undefined : BigInt(v as bigint)
}

export interface Position {
	bTokens: bigint
	/** Current value of the position in the underlying asset. */
	value: bigint
	/** Value of one bToken, as a float, for display. */
	bRate: number
}

/** bTokens held by `holder` in the pool and what they are worth now (bTokens × b_rate). */
export const getPosition = async (
	holder: string,
	pool = BLEND_POOL,
	asset = TOKEN,
): Promise<Position> => {
	const [positions, reserve] = await Promise.all([
		read<Record<string, unknown>>(pool, "get_positions", { address: holder }),
		read<{ config: { index: number }; data: { b_rate: bigint } }>(
			pool,
			"get_reserve",
			{ asset },
		),
	])
	const index = Number(reserve.config.index)
	const bTokens = mapGet(positions.supply, index) ?? 0n
	const bRate = BigInt(reserve.data.b_rate)
	// Blend v2 stores b_rate with 12 decimals (v1 used 9): detect to be safe
	const scale = bRate > 10n ** 11n ? 10n ** 12n : 10n ** 9n
	return {
		bTokens,
		value: (bTokens * bRate) / scale,
		bRate: Number(bRate) / Number(scale),
	}
}


// ---------- Sending transactions (with fee bump when needed) ----------


const UINT32_MAX = 4_294_967_295n
const server = new rpc.Server(rpcUrl)

/** Wallet signer, e.g. Freighter through Stellar Wallets Kit. */
export type Signer = (
	xdr: string,
	opts: { networkPassphrase: string; address: string },
) => Promise<{ signedTxXdr: string }>

type Sent = { hash: string; returnValue?: xdr.ScVal }

const submit = async (
	tx: Transaction | ReturnType<typeof TransactionBuilder.fromXDR>,
): Promise<Sent> => {
	const res = await server.sendTransaction(tx)
	if (res.status === "ERROR") {
		throw new Error(`Transaction rejected: ${res.errorResult?.result().switch().name ?? "error"}`)
	}
	for (let i = 0; i < 30; i++) {
		const got = await server.getTransaction(res.hash)
		if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
			return { hash: res.hash, returnValue: got.returnValue }
		}
		if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
			throw new Error(`Transaction failed on-chain (${res.hash.slice(0, 8)}…)`)
		}
		await new Promise((r) => setTimeout(r, 1500))
	}
	throw new Error("Timed out waiting for the transaction")
}

/**
 * Simulate, sign with the wallet and submit a contract call; returns the tx hash.
 * A normal transaction's fee field is a u32 (max ≈ 429 XLM). When testnet's
 * resource fees exceed that, wrap the call in a fee-bump transaction (as the
 * stellar CLI does): the wallet signs twice.
 */
export const invoke = async (
	contractId: string,
	method: string,
	args: Record<string, unknown> | undefined,
	source: string,
	sign: Signer,
): Promise<string> => {
	const client = await getClient(contractId)
	const op = new Contract(contractId).call(
		method,
		...client.spec.funcArgsToScVals(method, args ?? {}),
	)
	return (await sendOp(op, source, sign)).hash
}

/**
 * Landlord creates a new agreement: deploys a RentalDeposit instance and runs its
 * constructor with the terms in the same transaction. Returns the new contract id.
 */
export const createAgreement = async (
	terms: Record<string, unknown>,
	source: string,
	sign: Signer,
): Promise<{ id: string; hash: string }> => {
	const wasm = await server.getContractWasmByHash(WASM_HASH, "hex")
	const spec = contract.Spec.fromWasm(wasm)
	const salt = new Uint8Array(32)
	crypto.getRandomValues(salt)
	const op = Operation.createCustomContract({
		address: new Address(source),
		wasmHash: Buffer.from(WASM_HASH, "hex"),
		salt: Buffer.from(salt),
		constructorArgs: spec.funcArgsToScVals("__constructor", terms),
	})
	const sent = await sendOp(op, source, sign)
	if (!sent.returnValue) throw new Error("Deployment returned no contract id")
	return { id: Address.fromScVal(sent.returnValue).toString(), hash: sent.hash }
}

/** Simulate, sign (with fee bump if needed) and submit one Soroban operation. */
const sendOp = async (op: xdr.Operation, source: string, sign: Signer): Promise<Sent> => {
	const acc = await server.getAccount(source)
	const seq = acc.sequenceNumber()
	const raw = new TransactionBuilder(new Account(source, seq), {
		fee: BASE_FEE,
		networkPassphrase,
	})
		.addOperation(op)
		.setTimeout(300)
		.build()

	const sim = await server.simulateTransaction(raw)
	if (rpc.Api.isSimulationError(sim)) {
		throw new Error(`Simulation failed: ${sim.error.split("\n")[0]}`)
	}
	const data = sim.transactionData.build()
	const resourceFee = data.resourceFee().toBigInt()
	const opts = { networkPassphrase, address: source }

	if (resourceFee + BigInt(BASE_FEE) <= UINT32_MAX) {
		const tx = rpc.assembleTransaction(raw, sim).build()
		const { signedTxXdr } = await sign(tx.toXDR(), opts)
		return submit(TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase))
	}

	// ---- fee-bump path ----
	const auth = sim.result?.auth ?? []
	const func = op.body().invokeHostFunctionOp().hostFunction() // deploy is a host function too
	const zero = xdr.SorobanTransactionData.fromXDR(data.toXDR())
	zero.resourceFee(xdr.Int64.fromString("0"))
	const draft = new TransactionBuilder(new Account(source, seq), {
		fee: BASE_FEE,
		networkPassphrase,
	})
		.setSorobanData(zero)
		.addOperation(Operation.invokeHostFunction({ func, auth }))
		.setTimeout(300)
		.build()
	const env = draft.toEnvelope()
	env.v1().tx().ext().sorobanData().resourceFee(xdr.Int64.fromString(resourceFee.toString()))
	env.v1().tx().fee(Number(UINT32_MAX)) // the outer fee bump pays the real fee
	const inner = new Transaction(env, networkPassphrase)

	const signedInner = await sign(inner.toXDR(), opts)
	const innerTx = new Transaction(signedInner.signedTxXdr, networkPassphrase)
	const bump = TransactionBuilder.buildFeeBumpTransaction(
		source,
		BASE_FEE,
		innerTx,
		networkPassphrase,
	)
	const signedBump = await sign(bump.toXDR(), opts)
	return submit(TransactionBuilder.fromXDR(signedBump.signedTxXdr, networkPassphrase))
}

/**
 * Token balance held by an address/contract (the liquid part of the deposit).
 * Simulates `balance(id)` on the token directly, without building a token client.
 */
export const getBalance = async (holder: string, asset = TOKEN): Promise<bigint> => {
	const op = new Contract(asset).call("balance", new Address(holder).toScVal())
	// Any funded account works as the simulation source; read-only, never sent
	const acc = new Account(PLATFORM_ARBITER, "0")
	const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase })
		.addOperation(op)
		.setTimeout(60)
		.build()
	const sim = await server.simulateTransaction(tx)
	if (rpc.Api.isSimulationError(sim) || !sim.result) {
		throw new Error("balance simulation failed")
	}
	return BigInt(scValToNative(sim.result.retval) as bigint)
}

// ---------- Live Blend rates (same model as Blend's own UI/SDK) ----------

export interface PoolRates {
	utilization: number // share of supplied funds currently borrowed
	borrowApr: number
	supplyApr: number // what suppliers (our contract) earn
}

/** Blend v2 interest-rate model: piecewise-linear in utilization, scaled by ir_mod. */
export const getSupplyRates = async (pool = BLEND_POOL, asset = TOKEN): Promise<PoolRates> => {
	type Reserve = {
		config: Record<string, number | bigint>
		data: Record<string, bigint | number>
	}
	const [reserve, config] = await Promise.all([
		read<Reserve>(pool, "get_reserve", { asset }),
		read<{ bstop_rate: number }>(pool, "get_config").catch(() => ({ bstop_rate: 2_000_000 })),
	])
	const f7 = (x: number | bigint) => Number(x) / 1e7
	const f12 = (x: number | bigint) => Number(x) / 1e12
	const c = reserve.config
	const d = reserve.data
	const supplied = Number(d.b_supply) * f12(d.b_rate)
	const borrowed = Number(d.d_supply) * f12(d.d_rate)
	const u = supplied > 0 ? borrowed / supplied : 0
	const target = f7(c.util)
	const [rBase, rOne, rTwo, rThree] = [c.r_base, c.r_one, c.r_two, c.r_three].map(f7)
	const irMod = f7(d.ir_mod)
	let borrowApr: number
	if (u <= target) borrowApr = irMod * (rBase + (target > 0 ? u / target : 0) * rOne)
	else if (u <= 0.95) borrowApr = irMod * (rBase + rOne + ((u - target) / (0.95 - target)) * rTwo)
	else borrowApr = irMod * (rBase + rOne + rTwo) + ((u - 0.95) / 0.05) * rThree
	const supplyApr = borrowApr * u * (1 - f7(config.bstop_rate))
	return { utilization: u, borrowApr, supplyApr }
}

/** Our DeFindex position: vault shares held by `holder` and what they are worth now. */
export const getVaultPosition = async (
	holder: string,
	vault = DEFINDEX_VAULT,
): Promise<{ shares: bigint; value: bigint }> => {
	const shares = BigInt(await read<bigint>(vault, "balance", { id: holder }))
	if (shares <= 0n) return { shares, value: 0n }
	const amounts = await read<unknown>(vault, "get_asset_amounts_per_shares", {
		vault_shares: shares,
	})
	// Returns Result<Vec<i128>>: the bindings unwrap it to the Vec (or an Ok wrapper)
	const list = (
		Array.isArray(amounts)
			? amounts
			: ((amounts as { value?: unknown[] })?.value ?? [])
	) as bigint[]
	return { shares, value: BigInt(list[0] ?? 0) }
}

/** State of the shared DeFindex reserve: how much is idle vs invested in Blend. */
export const getReserveState = async (
	vault = DEFINDEX_VAULT,
): Promise<{ idle: bigint; invested: bigint }> => {
	const funds = await read<unknown>(vault, "fetch_total_managed_funds")
	const list = (
		Array.isArray(funds) ? funds : ((funds as { value?: unknown[] })?.value ?? [])
	) as { idle_amount: bigint; invested_amount: bigint }[]
	const a = list[0]
	return {
		idle: BigInt(a?.idle_amount ?? 0),
		invested: BigInt(a?.invested_amount ?? 0),
	}
}
