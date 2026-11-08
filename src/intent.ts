import Decimal from "decimal.js";
import { assetCode, normalize, parseAmountText, TOMAN } from "./money";
import type { NluOutput } from "./nlu";
import { fromToman } from "./parser";
import type { Trade } from "./trade";

export type Action =
  | { kind: "create"; trade: Trade }
  | { kind: "payment"; trade: Trade }
  | { kind: "settle"; dealCode: string }
  | { kind: "edit"; dealCode: string; changes: { amount?: Decimal; rate?: Decimal; note?: string } }
  | { kind: "cancel"; dealCode: string }
  | { kind: "balance"; clientHint?: string }
  | { kind: "remaining"; dealCode?: string; clientHint?: string }
  | { kind: "deals"; clientHint?: string }
  | { kind: "price"; coins: string[] }
  | { kind: "reply"; text: string }
  | { kind: "refuse" };

export interface IntentCtx {
  role: "admin" | "client";
  usdtToman: Decimal | null;
  defaultAsset: string;
}

const ASK_AMOUNT = "مبلغ رو متوجه نشدم. دقیق‌تر بگو، مثلاً «۱۰۰ تتر به قیمت ۲۷۵ هزار».";
const ASK_RATE = "برای مبلغ تومانی، قیمت لازمه. قیمت رو هم بگو.";
const ASK_RATE_PARSE = "قیمت رو متوجه نشدم. دقیق‌تر بگو، مثلاً «۲۷۵ هزار».";
const ASK_SIDE = "خرید بود یا فروش؟";
const ASK_DIRECTION = "پرداخت بود یا دریافت؟";
const ASK_DEAL = "کدوم معامله؟ کدش رو بگو، مثلاً D-00012.";
const ASK_CHANGE = "چی رو تغییر بدم؟ مبلغ، قیمت یا توضیح؟";
const UNCLEAR = "متوجه نشدم، یه بار دیگه واضح‌تر بگو.";

const reply = (text: string): Action => ({ kind: "reply", text });

/** Writing «۲۷۵» for 275,000 when the USDT price is around 266,000. */
export function expandRateShorthand(rate: Decimal, asset: string, usdtToman: Decimal | null): Decimal {
  if (asset !== "USDT" || usdtToman === null || rate.gte(10000)) return rate;
  const big = rate.mul(1000);
  return big.gte(usdtToman.mul("0.5")) && big.lte(usdtToman.mul("1.5")) ? big : rate;
}

/** (rate - ref) / ref x 100, one decimal place. */
export function deviationPct(rate: Decimal, ref: Decimal): Decimal {
  return rate.minus(ref).div(ref).mul(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
}

const WRITES = new Set(["create_trade", "record_payment", "settle_deal", "edit_deal", "cancel_deal"]);

function positive(text: string | undefined): Decimal | null {
  if (text === undefined) return null;
  const v = parseAmountText(text);
  return v !== null && v.gt(0) ? v : null;
}

const toCode = (word: string) => assetCode(normalize(word).trim().toLowerCase());

export function toAction(o: NluOutput, ctx: IntentCtx): Action {
  if (ctx.role === "client" && WRITES.has(o.intent)) return { kind: "refuse" };

  switch (o.intent) {
    case "create_trade": {
      if (!o.side) return reply(ASK_SIDE);
      const asset = o.asset ? toCode(o.asset) : ctx.defaultAsset;
      const amount = positive(o.amount_text);
      if (amount === null) return reply(ASK_AMOUNT);
      let rate: Decimal | null = null;
      if (o.rate_text) {
        const r = positive(o.rate_text);
        if (r === null) return reply(ASK_RATE_PARSE);
        rate = expandRateShorthand(r, asset, ctx.usdtToman);
      }
      let tomanTotal: Decimal | null = null;
      let units = amount;
      if (o.amount_unit === "toman") {
        if (rate === null) return reply(ASK_RATE);
        tomanTotal = amount;
        units = fromToman(amount, rate, asset);
        if (units.lte(0)) return reply(ASK_AMOUNT);
      }
      return {
        kind: "create",
        trade: { side: o.side, amount: units, asset, rate, note: o.note?.trim() ?? "", tomanTotal },
      };
    }
    case "record_payment": {
      if (!o.direction) return reply(ASK_DIRECTION);
      const amount = positive(o.amount_text);
      if (amount === null) return reply(ASK_AMOUNT);
      const asset = o.asset ? toCode(o.asset) : TOMAN;
      return {
        kind: "payment",
        trade: { side: o.direction, amount, asset, rate: null, note: o.note?.trim() ?? "", tomanTotal: null },
      };
    }
    case "settle_deal":
      return o.deal_code ? { kind: "settle", dealCode: o.deal_code } : reply(ASK_DEAL);
    case "cancel_deal":
      return o.deal_code ? { kind: "cancel", dealCode: o.deal_code } : reply(ASK_DEAL);
    case "edit_deal": {
      if (!o.deal_code) return reply(ASK_DEAL);
      const changes: { amount?: Decimal; rate?: Decimal; note?: string } = {};
      if (o.changes?.amount_text !== undefined) {
        const a = positive(o.changes.amount_text);
        if (a === null) return reply(ASK_AMOUNT);
        changes.amount = a;
      }
      if (o.changes?.rate_text !== undefined) {
        const r = positive(o.changes.rate_text);
        if (r === null) return reply(ASK_RATE_PARSE);
        changes.rate = expandRateShorthand(r, ctx.defaultAsset, ctx.usdtToman);
      }
      if (o.changes?.note !== undefined) changes.note = o.changes.note.trim();
      if (Object.keys(changes).length === 0) return reply(ASK_CHANGE);
      return { kind: "edit", dealCode: o.deal_code, changes };
    }
    case "query_balance":
      return { kind: "balance", clientHint: ctx.role === "admin" ? o.client_hint : undefined };
    case "query_remaining":
      return { kind: "remaining", dealCode: o.deal_code, clientHint: ctx.role === "admin" ? o.client_hint : undefined };
    case "query_deals":
      return { kind: "deals", clientHint: ctx.role === "admin" ? o.client_hint : undefined };
    case "query_price":
      return { kind: "price", coins: o.coins ?? [] };
    case "chitchat":
    case "unclear":
      return reply(o.reply?.trim() || UNCLEAR);
  }
}

export const DEFAULT_DEVIATION_PCT = 3;

/** A stored/entered deviation threshold: a positive plain decimal (Persian digits ok), else null. */
export function parseDeviationSetting(raw: string | null | undefined): Decimal | null {
  const s = normalize(raw ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const v = new Decimal(s);
  return v.gt(0) ? v : null;
}
