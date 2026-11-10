import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import { assetCode, assetName, fa, fmtNum, parseAmountText } from "../src/money";
import { parseTrade } from "../src/parser";
import { tradeTotal } from "../src/trade";

describe("parseAmountText", () => {
  test.each([
    ["۲ میلیون", "2000000"],
    ["۲۷۵ هزار", "275000"],
    ["275k", "275000"],
    ["1.5m", "1500000"],
    ["2,500,000", "2500000"],
    ["۱۰۰", "100"],
    ["۱۰۰ تا", "100"],
    ["۱۰۰ تتر", "100"],
    ["۱۰۰ تا تتر", "100"],
    ["۱۰۰ عدد دلار", "100"],
    ["۲۷۶ هزار تومن", "276000"],
    ["۵۰ میلیون تومان", "50000000"],
    ["۲ میلیون تومان", "2000000"],
    ["1.5m usdt", "1500000"],
    ["100 USDT", "100"],
    ["5 toman", "5"],
  ])("%s", (text, expected) => {
    expect(parseAmountText(text)?.equals(new Decimal(expected))).toBe(true);
  });

  test.each(["سلام", "", "12 abc", "۱۰۰ سلام", "۱۰۰ ریال", "۱۰۰ تتر سلام", "100 constructor"])("rejects %j", (text) => {
    expect(parseAmountText(text)).toBeNull();
  });
});

test("fmtNum", () => {
  expect(fmtNum(new Decimal("2000000"))).toBe("2,000,000");
  expect(fmtNum(new Decimal("1500.50"))).toBe("1,500.5");
});

test("fa", () => {
  expect(fa(new Decimal("27500000"))).toBe("۲۷,۵۰۰,۰۰۰");
  expect(fa(new Decimal("26435.05"))).toBe("۲۶,۴۳۵/۰۵");
  expect(fa(27500000)).toBe("۲۷۵۰۰۰۰۰");
});

test("asset lookups ignore prototype keys", () => {
  expect(parseTrade("#buy 5 constructor")?.asset).toBe("CONSTRUCTOR");
  expect(parseTrade("#sell 100 toString 50")?.asset).toBe("TOSTRING");
  expect(assetCode("constructor")).toBe("CONSTRUCTOR");
  expect(assetName("constructor")).toBe("constructor");
  expect(assetCode("تتر")).toBe("USDT");
  expect(assetName("USDT")).toBe("تتر");
});

test("trade total is exact at high precision", () => {
  const t = parseTrade("#buy 123456789012.123456 usdt @ 987654321.987654")!;
  const exact = (123456789012123456n * 987654321987654n).toString(); // scaled by 10^(6+6)
  const expected = exact.slice(0, -12) + "." + exact.slice(-12);
  expect(tradeTotal(t)!.toFixed()).toBe(expected.replace(/\.?0+$/, ""));
});

describe("parseAmountText: compound amounts and separators", () => {
  const p = (s: string) => parseAmountText(s)?.toFixed() ?? null;
  test.each([
    ["۵ میلیارد و ۲۳۲ میلیون", "5232000000"],
    ["۵ میلیارد و ۲۳۲ میلیون تومان", "5232000000"],
    ["۲ میلیون و ۵۰۰ هزار", "2500000"],
    ["۱ میلیارد و ۲۰۰ میلیون و ۳۰۰ هزار و ۵۰۰", "1200300500"],
    ["۵ میلیارد ۲۳۲ میلیون", "5232000000"],
    ["۵میلیارد و ۲۳۲میلیون", "5232000000"],
    ["۵/۲۳۲/۴۵۶/۸۷۶", "5232456876"],
    ["۵/۲۳۲/۴۵۶/۸۷۶ تومان", "5232456876"],
    ["5.232.456.876", "5232456876"],
    ["۱/۵ میلیون", "1500000"],
    ["۲۶۸/۵", "268.5"],
  ])("%s -> %s", (s, want) => {
    expect(p(s)).toBe(want);
  });
  test.each(["۵ و", "و ۵ میلیون", "۵ ۲۳۲", "۵ میلیارد و سلام", "۵/۲۳/۴۵۶", "۵ میلیون و ۲ میلیارد"])("%s -> null", (s) => {
    expect(p(s)).toBeNull();
  });
});
