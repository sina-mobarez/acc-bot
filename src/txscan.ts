/**
 * Pure rules of the transaction scan: is this transfer ours and which way, does it fit a deal, and
 * what should the admin be warned about. Numbers come from chain.ts as Decimals; nothing here
 * talks to the network or the database.
 */
import Decimal from "decimal.js";
import type { Network, TxInfo } from "./chain";
import type { Entry } from "./db";
import type { Leg } from "./ledger";
import { fa } from "./money";
import { isPayment } from "./trade";

const NET_NAME = new Map<Network, string>([["TRON", "ترون (TRC20)"], ["BSC", "BSC (BEP20)"]]);
export const networkName = (n: Network): string => NET_NAME.get(n) ?? n;

// Refusals: no card is made.
export const NO_WALLET = (n: Network) => `کیف پول ${networkName(n)} در مینی‌اپ ثبت نشده؛ اول آدرس را در تنظیمات وارد کنید.`;
export const FAILED = "این تراکنش ناموفق بوده (روی شبکه رد شده است).";
export const NOT_USDT = "در این تراکنش انتقال تتر (USDT) پیدا نشد.";
export const NOT_OURS = "این تراکنش به کیف پول ما یا از کیف پول ما نیست.";
export const AMBIGUOUS = "این تراکنش هم به کیف پول ما واریز دارد هم از آن برداشت؛ دستی بررسی شود.";
export const NOT_FOUND = "این تراکنش هنوز روی شبکه پیدا نشد. اگر تازه ارسال شده، یک دقیقه دیگر دوباره بفرستید.";
export const LOOKUP_ERROR = "الان نتوانستم تراکنش را بررسی کنم؛ کمی بعد دوباره بفرستید.";
export const DUPLICATE = (code: string | null) =>
  code ? `این تراکنش قبلاً ثبت شده است: <code>${code}</code>` : "این تراکنش قبلاً ثبت شده است.";

// Warnings: the card is made, the admin decides.
export const NOT_FINAL = (n: Network, confirmations: number) =>
  `تراکنش هنوز قطعی نشده (${fa(confirmations)} تأیید روی ${networkName(n)}).`;
export const DEAL_NOT_APPROVED = "معامله‌ی مرتبط هنوز تایید نشده است.";
export const DEAL_SETTLED = "معامله‌ی مرتبط قبلاً تسویه شده است.";
export const AMOUNT_MISMATCH = (amount: Decimal, remaining: Decimal) =>
  `مبلغ تراکنش (${fa(amount)} تتر) با باقی‌مانده‌ی معامله (${fa(remaining)} تتر) برابر نیست.`;
export const DEAL_MISFIT = "این کارت با این تراکنش جور نیست (پرداخت است، یا تتری در این جهت ندارد)؛ معامله را انتخاب کنید.";

const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BSC_RE = /^0x[0-9a-fA-F]{40}$/;
const MISMATCH_FROM = new Decimal("0.01");

/** A wallet address as stored and compared (BSC lowercased), or null if it isn't one. */
export function parseWallet(network: Network, raw: string): string | null {
  const s = (raw ?? "").trim();
  if (network === "TRON") return TRON_RE.test(s) ? s : null;
  return BSC_RE.test(s) ? s.toLowerCase() : null;
}

export type Classified =
  | { kind: "ok"; side: "RECEIVE" | "PAY"; amount: Decimal; counterparty: string }
  | { kind: "refuse"; text: string };

/** Which way the USDT moved relative to our wallet (`wallet` already through parseWallet). */
export function classify(tx: TxInfo, wallet: string | null): Classified {
  if (wallet === null) return { kind: "refuse", text: NO_WALLET(tx.network) };
  if (!tx.succeeded) return { kind: "refuse", text: FAILED };
  if (!tx.transfers.length) return { kind: "refuse", text: NOT_USDT };
  const same = (a: string) => (tx.network === "BSC" ? a.toLowerCase() === wallet : a === wallet);
  let incoming = new Decimal(0);
  let outgoing = new Decimal(0);
  let inFrom: string | null = null;
  let outTo: string | null = null;
  for (const t of tx.transfers) {
    const toUs = same(t.to);
    const fromUs = same(t.from);
    if (toUs && fromUs) continue; // moving our own money around
    if (toUs) {
      incoming = incoming.plus(t.amount);
      inFrom ??= t.from;
    } else if (fromUs) {
      outgoing = outgoing.plus(t.amount);
      outTo ??= t.to;
    }
  }
  if (incoming.isZero() && outgoing.isZero()) return { kind: "refuse", text: NOT_OURS };
  if (!incoming.isZero() && !outgoing.isZero()) return { kind: "refuse", text: AMBIGUOUS };
  return incoming.isZero()
    ? { kind: "ok", side: "PAY", amount: outgoing, counterparty: outTo! }
    : { kind: "ok", side: "RECEIVE", amount: incoming, counterparty: inFrom! };
}

/** A deal this payment can count against: a USDT trade owing USDT in the payment's direction. */
export function dealFit(deal: Entry, side: "RECEIVE" | "PAY"): boolean {
  const t = deal.trade;
  if (isPayment(t) || t.asset !== "USDT") return false;
  return (t.side === "BUY" && side === "RECEIVE") || (t.side === "SELL" && side === "PAY");
}

export interface WarningInput {
  final: boolean;
  network: Network;
  confirmations: number;
  amount: Decimal;
  deal: Entry | null;
  /** The deal's USDT leg in the payment's direction, after approved payments (null if none). */
  leg: Leg | null;
}

export function warnings(o: WarningInput): string[] {
  const out: string[] = [];
  if (!o.final) out.push(NOT_FINAL(o.network, o.confirmations));
  if (o.deal) {
    if (o.deal.status !== "approved") out.push(DEAL_NOT_APPROVED);
    else if (!o.leg || o.leg.remaining.lte(0)) out.push(DEAL_SETTLED);
    else if (o.amount.minus(o.leg.remaining).abs().gte(MISMATCH_FROM)) out.push(AMOUNT_MISMATCH(o.amount, o.leg.remaining));
  }
  return out;
}
