import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import { fa, fmtNum, parseAmountText } from "../src/money";

describe("parseAmountText", () => {
  test.each([
    ["۲ میلیون", "2000000"],
    ["۲۷۵ هزار", "275000"],
    ["275k", "275000"],
    ["1.5m", "1500000"],
    ["2,500,000", "2500000"],
  ])("%s", (text, expected) => {
    expect(parseAmountText(text)?.equals(new Decimal(expected))).toBe(true);
  });

  test.each(["سلام", "", "12 abc"])("rejects %j", (text) => {
    expect(parseAmountText(text)).toBeNull();
  });
});

test("fmtNum", () => {
  expect(fmtNum(new Decimal("2000000"))).toBe("2,000,000");
  expect(fmtNum(new Decimal("1500.50"))).toBe("1,500.5");
});

test("fa", () => {
  expect(fa(new Decimal("27500000"))).toBe("۲۷٬۵۰۰٬۰۰۰");
  expect(fa(27500000)).toBe("۲۷۵۰۰۰۰۰");
});
