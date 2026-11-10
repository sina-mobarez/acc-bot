/**
 * On-chain lookups for the transaction scan: find a hash in text, then ask Tronscan (TRON) or a
 * BSC JSON-RPC node what the transaction did. Only official USDT transfers are reported, and every
 * amount and fee is a Decimal built from the chain's integer strings (never a JS number).
 */
import Decimal from "decimal.js";
import type { Network } from "./db";
import { normalize } from "./money";

export type { Network } from "./db";

export const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
export const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRONSCAN_URL = "https://apilist.tronscanapi.com/api/transaction-info?hash=";
export const BSC_RPC_DEFAULT = "https://bsc-dataseed.bnbchain.org";
export const BSC_FINAL_CONFIRMATIONS = 15;
const TIMEOUT_MS = 5000;

export interface HashRef {
  hash: string;
  networks: Network[];
}

export interface UsdtTransfer {
  from: string;
  to: string;
  amount: Decimal;
}

export interface TxInfo {
  network: Network;
  hash: string;
  succeeded: boolean;
  transfers: UsdtTransfer[];
  confirmations: number;
  final: boolean;
  fee: Decimal;
  feeAsset: "TRX" | "BNB";
}

export type Lookup = { kind: "found"; tx: TxInfo } | { kind: "not_found" } | { kind: "error" };

const HASH_RE = /(?<![0-9a-fA-F])(0[xX])?([0-9a-fA-F]{64})(?![0-9a-fA-F])/;

/** The first transaction hash in `text`: `0x…` is BSC; a bare one is tried on TRON, then BSC. */
export function findTxHash(text: string): HashRef | null {
  const m = HASH_RE.exec(normalize(text ?? ""));
  if (!m) return null;
  const bare = m[2].toLowerCase();
  return m[1] ? { hash: `0x${bare}`, networks: ["BSC"] } : { hash: bare, networks: ["TRON", "BSC"] };
}

export function explorerUrl(network: Network, hash: string): string {
  return network === "TRON" ? `https://tronscan.org/#/transaction/${hash}` : `https://bscscan.com/tx/${hash}`;
}

/** A non-negative integer (decimal string, number or 0x-hex) as a Decimal, else null. */
function int(v: unknown): Decimal | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() && d.isInteger() && d.gte(0) ? d : null;
  } catch {
    return null;
  }
}

async function getJson(f: typeof fetch, url: string, init: RequestInit = {}): Promise<any | null> {
  try {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 200) {
      console.warn("chain lookup failed", new URL(url).host, res.status, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn("chain lookup failed", new URL(url).host, String(e));
    return null;
  }
}

export async function lookupTron(hash: string, f: typeof fetch, apiKey?: string): Promise<Lookup> {
  const body = await getJson(f, TRONSCAN_URL + encodeURIComponent(hash), apiKey ? { headers: { "TRON-PRO-API-KEY": apiKey } } : {});
  if (body === null || typeof body !== "object") return { kind: "error" };
  if (typeof body.hash !== "string") return { kind: "not_found" };
  const transfers: UsdtTransfer[] = [];
  for (const t of Array.isArray(body.trc20TransferInfo) ? body.trc20TransferInfo : []) {
    if (t?.contract_address !== TRON_USDT || t?.type !== "Transfer") continue;
    const raw = int(t.amount_str);
    const decimals = Number(t.decimals);
    if (raw === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    if (typeof t.from_address !== "string" || typeof t.to_address !== "string") continue;
    transfers.push({ from: t.from_address, to: t.to_address, amount: raw.div(new Decimal(10).pow(decimals)) });
  }
  const cost = body.cost ?? {};
  let sun = new Decimal(0);
  for (const k of ["energy_fee", "net_fee", "multi_sign_fee", "memoFee"]) sun = sun.plus(int(cost[k]) ?? 0);
  return {
    kind: "found",
    tx: {
      network: "TRON",
      hash: body.hash.toLowerCase(),
      succeeded: body.contractRet === "SUCCESS" && body.revert !== true,
      transfers,
      confirmations: Number.isInteger(body.confirmations) ? body.confirmations : 0,
      final: body.confirmed === true,
      fee: sun.div(1e6),
      feeAsset: "TRX",
    },
  };
}

const topicAddress = (topic: unknown): string | null =>
  typeof topic === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null;

export async function lookupBsc(hash: string, f: typeof fetch, rpcUrl: string = BSC_RPC_DEFAULT): Promise<Lookup> {
  const body = await getJson(f, rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] },
      { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
    ]),
  });
  if (!Array.isArray(body)) return { kind: "error" };
  const byId = new Map<unknown, any>(body.map((r: any) => [r?.id, r]));
  const rec = byId.get(1);
  const head = int(byId.get(2)?.result);
  if (!rec || rec.error || head === null) return { kind: "error" };
  const r = rec.result;
  if (r === null) return { kind: "not_found" };
  const block = int(r?.blockNumber);
  if (!r || block === null) return { kind: "error" };

  const transfers: UsdtTransfer[] = [];
  for (const log of Array.isArray(r.logs) ? r.logs : []) {
    if (typeof log?.address !== "string" || log.address.toLowerCase() !== BSC_USDT) continue;
    if (!Array.isArray(log.topics) || log.topics.length !== 3 || String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.removed === true) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    const raw = int(log.data);
    if (!from || !to || raw === null) continue;
    transfers.push({ from, to, amount: raw.div("1e18") });
  }
  const confirmations = Decimal.max(head.minus(block).plus(1), 0).toNumber();
  return {
    kind: "found",
    tx: {
      network: "BSC",
      hash: hash.toLowerCase(),
      succeeded: r.status === "0x1",
      transfers,
      confirmations,
      final: confirmations >= BSC_FINAL_CONFIRMATIONS,
      fee: (int(r.gasUsed) ?? new Decimal(0)).mul(int(r.effectiveGasPrice) ?? 0).div("1e18"),
      feeAsset: "BNB",
    },
  };
}

/** Try each candidate network in order; the first that knows the hash wins. */
export async function lookupTx(
  ref: HashRef,
  f: typeof fetch,
  env: Pick<Env, "TRONSCAN_API_KEY" | "BSC_RPC_URL">,
): Promise<Lookup> {
  let errored = false;
  for (const net of ref.networks) {
    const r =
      net === "TRON"
        ? await lookupTron(ref.hash.replace(/^0x/, ""), f, env.TRONSCAN_API_KEY || undefined)
        : await lookupBsc(ref.hash.startsWith("0x") ? ref.hash : `0x${ref.hash}`, f, env.BSC_RPC_URL || undefined);
    if (r.kind === "found") return r;
    if (r.kind === "error") errored = true;
  }
  return errored ? { kind: "error" } : { kind: "not_found" };
}
