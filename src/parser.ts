/**
 * Parse trade and payment messages in Persian or English. Every message must
 * start with # so ordinary chat is never taken as a deal.
 *
 * Everything is from our side: buy = we buy from the client, pay = we pay the
 * client, receive = the client pays us.
 */
import Decimal from "decimal.js";
import {
  ASSETS, ASSET_NAMES, MULT, NUM, PRECISION, TOMAN, WORD_END,
  applyMult, assetCode, escapeRe, normalize,
} from "./money";
import type { Side, Trade } from "./trade";

const SIDES: Record<string, Side> = { buy: "BUY", "خرید": "BUY", sell: "SELL", "فروش": "SELL" };
const PAYMENT_SIDES: Record<string, Side> = {
  "پرداخت": "PAY", "ارسال": "PAY", pay: "PAY", paid: "PAY",
  "دریافت": "RECEIVE", receive: "RECEIVE", received: "RECEIVE",
};

const W = WORD_END;
const COUNT_WORD = `(?:تا|عدد)${W}`;
const RATE_KW = `(?:@|(?:(?:رو|روی|به|با|در)\\s+)?(?:قیمت|نرخ|فی)${W}|at${W}|rate${W})`;
const CURRENCY = `(?:تومن|تومان|toman)${W}`;
const HASHTAG = "#\\s*";
// Payments only accept known asset names so a note like "بانک ملت" isn't taken as one.
const KNOWN_ASSET = [...Object.keys(ASSETS), ...Object.keys(ASSET_NAMES)]
  .sort((a, b) => b.length - a.length)
  .map(escapeRe)
  .join("|");

const TRADE_RE = new RegExp(
  `^\\s*${HASHTAG}` +
    `(?<side>buy|sell|خرید|فروش)\\s+` +
    `(?<amount>${NUM})\\s*` +
    `(?:(?<mult>${MULT})${W})?\\s*` +
    `(?:(?<toman>${CURRENCY})\\s*)?` + // "۵۰۰ میلیون تومان تتر": the amount is in toman
    `(?:${COUNT_WORD}\\s*)?` +
    `(?:(?!${COUNT_WORD}|${RATE_KW}|${CURRENCY})(?<asset>\\p{L}{2,15}))?` +
    `(?:\\s*${RATE_KW}?\\s*(?<rate>${NUM})\\s*(?:(?<rmult>${MULT})${W})?\\s*(?:${CURRENCY})?)?` +
    `(?:\\s+(?<note>.+?))?` +
    `\\s*$`,
  "isu",
);

const PAYMENT_RE = new RegExp(
  `^\\s*${HASHTAG}` +
    `(?<side>${Object.keys(PAYMENT_SIDES).join("|")})\\s+` +
    `(?<amount>${NUM})\\s*` +
    `(?:(?<mult>${MULT})${W})?\\s*` +
    `(?:(?<asset>${KNOWN_ASSET})${W})?` +
    `(?:\\s+(?<note>.+?))?` +
    `\\s*$`,
  "isu",
);

/** A message that is clearly a trade but can't be recorded; the message is Persian. */
export class TradeError extends Error {}

/** toman / rate, rounded half-up to the asset's precision (default 8 places). */
export function fromToman(toman: Decimal, rate: Decimal, asset: string): Decimal {
  return toman.div(rate).toDecimalPlaces(PRECISION[asset] ?? 8, Decimal.ROUND_HALF_UP);
}

/**
 * Return a Trade if text matches the trade syntax, else null.
 *
 * "#خرید ۵۰۰ میلیون تومان تتر به قیمت ۲۶۴۰۰۰" is a toman amount: the asset
 * amount is 500,000,000 / 264,000 and the toman total stays exact. Throws
 * TradeError when such a message has no price.
 */
export function parseTrade(text: string, defaultAsset = "USDT"): Trade | null {
  const g = TRADE_RE.exec(normalize(text))?.groups;
  if (!g) return null;
  let amount: Decimal;
  let rate: Decimal | null;
  try {
    amount = applyMult(g.amount, g.mult);
    rate = g.rate ? applyMult(g.rate, g.rmult) : null;
  } catch {
    return null;
  }
  if (amount.lte(0) || (rate !== null && rate.lte(0))) return null;
  const asset = assetCode(g.asset ?? defaultAsset);
  let tomanTotal: Decimal | null = null;
  if (g.toman) {
    if (rate === null) {
      throw new TradeError(
        "برای معامله با مبلغ تومانی، قیمت لازم است. مثال:\n#خرید ۵۰۰ میلیون تومان تتر به قیمت ۲۶۴۰۰۰",
      );
    }
    tomanTotal = amount;
    amount = fromToman(tomanTotal, rate, asset);
    if (amount.lte(0)) return null;
  }
  return {
    side: SIDES[g.side.toLowerCase()],
    amount,
    asset,
    rate,
    note: (g.note ?? "").trim(),
    tomanTotal,
  };
}

/** Return a PAY/RECEIVE entry if text matches the payment syntax, else null. */
export function parsePayment(text: string): Trade | null {
  const g = PAYMENT_RE.exec(normalize(text))?.groups;
  if (!g) return null;
  let amount: Decimal;
  try {
    amount = applyMult(g.amount, g.mult);
  } catch {
    return null;
  }
  if (amount.lte(0)) return null;
  const asset = g.asset ?? TOMAN;
  return {
    side: PAYMENT_SIDES[g.side.toLowerCase()],
    amount,
    asset: assetCode(asset.toLowerCase()),
    rate: null,
    note: (g.note ?? "").trim(),
    tomanTotal: null,
  };
}

export function parseMessage(text: string, defaultAsset = "USDT"): Trade | null {
  return parseTrade(text, defaultAsset) ?? parsePayment(text);
}
