import type Decimal from "decimal.js";
import { TOMAN } from "./money";

export type Side = "BUY" | "SELL" | "PAY" | "RECEIVE";

/** A deal (BUY/SELL, priced in toman) or a payment (PAY/RECEIVE of any asset). */
export interface Trade {
  side: Side;
  amount: Decimal;
  asset: string;
  rate: Decimal | null; // toman per unit; trades only
  note: string;
  tomanTotal: Decimal | null; // set when the trade was written as a toman amount
}

export const byToman = (t: Trade): boolean => t.tomanTotal !== null;

export const isPayment = (t: Trade): boolean => t.side === "PAY" || t.side === "RECEIVE";

/** Toman value: amount x rate for trades, the amount itself for toman payments. */
export function tradeTotal(t: Trade): Decimal | null {
  if (t.tomanTotal !== null) return t.tomanTotal;
  if (t.rate !== null) return t.amount.mul(t.rate);
  if (isPayment(t) && t.asset === TOMAN) return t.amount;
  return null;
}
