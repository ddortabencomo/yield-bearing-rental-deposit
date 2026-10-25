import { contract } from "@stellar/stellar-sdk"
import { networkPassphrase, rpcUrl } from "@stellar-scaffold/app-lib"

// ---------- Testnet configuration ----------

/** Blend v2 testnet pool (TestnetV2, from blend-capital/blend-utils testnet.contracts.json). */
export const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"
/** Asset the deposit is held in. XLM for now; Blend's testnet USDC is CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU */
export const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
export const TOKEN_SYMBOL = "XLM"
export const DECIMALS = 7
/** RentalDeposit wasm already uploaded to testnet: new agreements are instances of it. */
export const WASM_HASH =
	"3fe719f9999df0c91e4c449650c0fc792f5575fcb72f3b789f2fa69ee031d509"
/** Same cap the contract enforces on-chain. */
export const MAX_INVEST_BPS = 8000
/** Default instance (overridden by ?id=C... in the URL). */
export const DEFAULT_CONTRACT =
	"CDNGPDZUBJRZV4LK3KPAGYY2DYKLOFMGPM7WJFEMM6IZ6SC6EA2SAUND"

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

export type StateName = "Funded" | "DeductionProposed" | "Disputed" | "Closed"

export interface Deposit {
	tenant: string
	landlord: string
	token: string
	pool: string
	amount: bigint
	invest_bps: number
	invested: bigint
	deduction: bigint
	evidence: string
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
