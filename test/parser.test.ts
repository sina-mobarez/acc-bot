import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import { fromToman, parseMessage, parsePayment, parseTrade, TradeError } from "../src/parser";
import { byToman, isPayment, tradeTotal } from "../src/trade";

const dec = (s: string) => new Decimal(s);

test.each([
  ["#خرید ۱۰۰ تا تتر رو قیمت ۲۷۵۰۰۰ تومن", "BUY", "100", "USDT", "275000"],
  ["#فروش ۳۰۰ تا تتر رو قیمت ۳۲۰۰۰۰", "SELL", "300", "USDT", "320000"],
  ["#خرید ۲ میلیون تتر", "BUY", "2000000", "USDT", null],
  ["#فروش ۱٫۵ میلیون تتر", "SELL", "1500000", "USDT", null],
  ["#خرید ۱۰۰ تتر به قیمت ۲۷۵٬۵۰۰", "BUY", "100", "USDT", "275500"],
  ["#فروش ۵۰۰ تتر ۲۷۵ هزار تومان", "SELL", "500", "USDT", "275000"],
  ["#خرید ۱۰۰ دلار فی ۹۰۰۰۰", "BUY", "100", "USD", "90000"],
  ["#خرید ۱۰۰ تا رو قیمت ۲۷۵۰۰۰", "BUY", "100", "USDT", "275000"],
  ["#خريد ١٠٠ تتر", "BUY", "100", "USDT", null], // Arabic yeh and digits
  ["#sell 100 usdt", "SELL", "100", "USDT", null],
  ["#buy 2 m usdt", "BUY", "2000000", "USDT", null],
  ["#buy 2 milion usdt", "BUY", "2000000", "USDT", null],
  ["#sell 250k usdt @ 3.6725", "SELL", "250000", "USDT", "3.6725"],
  ["#buy 100 btc", "BUY", "100", "BTC", null],
  ["#buy 500", "BUY", "500", "USDT", null],
  ["# فروش ۳۰۰ تتر ۳۲۰۰۰۰", "SELL", "300", "USDT", "320000"],
])("parses %s", (text, side, amount, asset, rate) => {
  const t = parseTrade(text);
  expect(t).not.toBeNull();
  expect([t!.side, t!.asset]).toEqual([side, asset]);
  expect(t!.amount.equals(dec(amount))).toBe(true);
  if (rate) expect(t!.rate?.equals(dec(rate))).toBe(true);
  else expect(t!.rate).toBeNull();
});

test("note after rate", () => {
  const t = parseTrade("#فروش ۵۰۰ تتر رو قیمت ۲۷۵۰۰۰ تومن بانک ملت")!;
  expect(t.note).toBe("بانک ملت");
  expect(tradeTotal(t)!.equals(dec("137500000"))).toBe(true);
});

test.each([
  "سلام", "#سلام", "خریدم ۱۰۰ تتر", "پرداخت شد", "دریافتی ۱۰۰", "فردا خرید ۱۰۰ تتر", "خرید تتر",
  "buy usdt", "selling 100 usdt", "buy 0 usdt", "",
])("rejects non-trade %j", (text) => {
  expect(parseMessage(text)).toBeNull();
});

test.each([
  ["#دریافت ۵۰ میلیون تومن کارت به کارت", "RECEIVE", "50000000", "IRT", "کارت به کارت"],
  ["#پرداخت ۲۷٬۵۰۰٬۰۰۰ بانک ملت", "PAY", "27500000", "IRT", "بانک ملت"],
  ["#پرداخت ۱۰۰ تتر", "PAY", "100", "USDT", ""],
  ["#ارسال ۲۰۰ تتر شبکه ترون", "PAY", "200", "USDT", "شبکه ترون"],
  ["#دریافت ۱۰۰ USDT", "RECEIVE", "100", "USDT", ""],
  ["#receive 1m toman", "RECEIVE", "1000000", "IRT", ""],
])("parses payment %s", (text, side, amount, asset, note) => {
  const p = parsePayment(text)!;
  expect([p.side, p.asset, p.note]).toEqual([side, asset, note]);
  expect(p.amount.equals(dec(amount))).toBe(true);
  expect(isPayment(p) && p.rate === null).toBe(true);
});

test("toman payment total", () => {
  expect(tradeTotal(parsePayment("#دریافت ۵ میلیون")!)!.equals(dec("5000000"))).toBe(true);
  expect(tradeTotal(parsePayment("#پرداخت ۱۰۰ تتر")!)).toBeNull();
});

test.each([
  "خرید ۱۰۰ تا تتر رو قیمت ۲۷۵۰۰۰ تومن", "فروش ۳۰۰ تتر", "دریافت ۵۰ میلیون تومن", "buy 2 m usdt",
])("requires hashtag: %s", (text) => {
  expect(parseMessage(text)).toBeNull();
  expect(parseMessage("#" + text)).not.toBeNull();
});

test.each([
  ["#خرید ۵۰۰ میلیون تومان به قیمت ۲۶۴۰۰۰", "BUY", "500000000", "264000", "1893.94"],
  ["#خرید ۱ میلیارد تومن تتر به قیمت ۲۶۵۰۰۰", "BUY", "1000000000", "265000", "3773.58"],
  ["#فروش ۲۶۴ میلیون تومن تتر ۲۶۴۰۰۰", "SELL", "264000000", "264000", "1000"],
  ["#فروش ۵۰۰ میلیون تومان به قیمت ۲۶۴۰۰۰", "SELL", "500000000", "264000", "1893.94"],
  ["#فروش ۱ میلیارد تومن تتر به قیمت ۲۶۵۰۰۰", "SELL", "1000000000", "265000", "3773.58"],
  ["#خرید ۵۰۰ میلیون تومان تتر فی ۲۶۴ هزار بانک ملت", "BUY", "500000000", "264000", "1893.94"],
])("toman amount converts to asset: %s", (text, side, toman, rate, amount) => {
  const t = parseTrade(text)!;
  expect([t.side, t.asset]).toEqual([side, "USDT"]);
  expect(t.rate!.equals(dec(rate))).toBe(true);
  expect(t.amount.equals(dec(amount))).toBe(true);
  expect(tradeTotal(t)!.equals(dec(toman))).toBe(true); // exact, not amount x rate
  expect(byToman(t)).toBe(true);
});

test("toman amount without price is an error", () => {
  expect(() => parseTrade("#خرید ۵۰۰ میلیون تومان تتر")).toThrow(TradeError);
});

test("unit amount is not by toman", () => {
  expect(byToman(parseTrade("#خرید ۱۰۰ تتر ۲۶۴۰۰۰")!)).toBe(false);
});

describe("fromToman", () => {
  test("rounds half-up to asset precision", () => {
    expect(fromToman(dec("500000000"), dec("264000"), "USDT").toString()).toBe("1893.94");
    expect(fromToman(dec("1"), dec("8"), "USDT").toString()).toBe("0.13"); // 0.125 -> half-up
  });
  test("defaults to 8 places for other assets", () => {
    expect(fromToman(dec("1"), dec("3"), "BTC").toString()).toBe("0.33333333");
  });
});
