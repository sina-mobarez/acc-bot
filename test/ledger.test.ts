import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import { allocate, debts, type LedgerEntry, openDeals, summarize } from "../src/ledger";
import { parseTrade } from "../src/parser";
import type { Side, Trade } from "../src/trade";

const D = (s: string | number) => new Decimal(s);

function T(side: Side, amount: string | number, asset = "USDT", rate?: string | number): Trade {
  return {
    side,
    amount: D(amount),
    asset,
    rate: rate === undefined ? null : D(rate),
    note: "",
    tomanTotal: null,
  };
}

const owed = (trades: Trade[]) =>
  debts(summarize(trades)).map(([k, v]) => `${k}=${v.toString()}`);

describe("summarize", () => {
  test("trades create opposite debts", () => {
    expect(owed([T("BUY", 100, "USDT", 275000), T("SELL", 300, "USDT", 320000)])).toEqual([
      "USDT=-200",
      "IRT=68500000",
    ]);
  });

  test("payments settle debts", () => {
    const acc = summarize([
      T("BUY", 100, "USDT", 275000),
      T("PAY", 27_500_000, "IRT"),
      T("RECEIVE", 100, "USDT"),
    ]);
    expect(debts(acc).map(([k, v]) => `${k}=${v.toString()}`)).toEqual(["USDT=0", "IRT=0"]);
    expect(acc.paid.get("IRT")?.equals(27_500_000)).toBe(true);
    expect(acc.received.get("USDT")?.equals(100)).toBe(true);
    expect(acc.paid.size).toBe(1);
    expect(acc.received.size).toBe(1);
  });

  test("toman sell debts", () => {
    const t = parseTrade("#فروش ۵۰۰ میلیون تومان به قیمت ۲۶۴۰۰۰");
    expect(t).not.toBeNull();
    expect(owed([t as Trade])).toEqual(["USDT=-1893.94", "IRT=500000000"]);
  });

  test("partial payment", () => {
    expect(owed([T("SELL", 100, "USDT", 300000), T("RECEIVE", 10_000_000, "IRT")])).toEqual([
      "USDT=-100",
      "IRT=20000000",
    ]);
  });

  test("unpriced trade skips toman leg", () => {
    const acc = summarize([T("BUY", 50)]);
    expect(debts(acc).map(([k, v]) => `${k}=${v.toString()}`)).toEqual(["USDT=50"]);
    expect(acc.unpriced).toBe(1);
  });

  test("trade stats", () => {
    const acc = summarize([
      T("BUY", 100, "USDT", 275000),
      T("BUY", 200, "USDT", 280000),
      T("SELL", 50),
      T("BUY", 1, "BTC"),
    ]);
    const [usdt, btc] = acc.trades;
    expect([usdt.asset, btc.asset]).toEqual(["USDT", "BTC"]);
    expect([usdt.bought.toString(), usdt.sold.toString()]).toEqual(["300", "50"]);
    expect(usdt.avgBuy?.toDecimalPlaces(0).toString()).toBe("278333");
    expect(usdt.avgSell).toBeNull();
    expect(usdt.unpriced).toBe(1);
  });

  test("asset names matching Object prototype keys are safe", () => {
    expect(owed([T("BUY", 1, "constructor"), T("BUY", 1, "__proto__")])).toEqual([
      "__proto__=1",
      "constructor=1",
    ]);
  });
});

const entry = (id: number, trade: Trade, linkedDealId: number | null = null): LedgerEntry => ({
  id,
  trade,
  linkedDealId,
});
const rem = (legs: { dir: string; asset: string; remaining: Decimal }[] | undefined) =>
  (legs ?? []).map((l) => `${l.dir}:${l.asset}:${l.remaining}`);

describe("allocate", () => {
  test("partial payment leaves remainders", () => {
    const m = allocate([
      entry(1, T("SELL", 100, "USDT", 300000)),
      entry(2, T("RECEIVE", 10_000_000, "IRT")),
    ]);
    expect(rem(m.get(1))).toEqual(["we_owe:USDT:100", "client_owes:IRT:20000000"]);
  });

  test("unlinked payment is FIFO, oldest first", () => {
    const m = allocate([
      entry(1, T("SELL", 10, "USDT", 1_000_000)),
      entry(2, T("SELL", 10, "USDT", 1_000_000)),
      entry(3, T("RECEIVE", 15_000_000, "IRT")),
    ]);
    expect(m.get(1)?.[1].remaining.toString()).toBe("0");
    expect(m.get(2)?.[1].remaining.toString()).toBe("5000000");
  });

  test("linked payment applies to its deal first", () => {
    const m = allocate([
      entry(1, T("SELL", 10, "USDT", 1_000_000)),
      entry(2, T("SELL", 10, "USDT", 1_000_000)),
      entry(3, T("RECEIVE", 10_000_000, "IRT"), 2),
    ]);
    expect(m.get(1)?.[1].remaining.toString()).toBe("10000000");
    expect(m.get(2)?.[1].remaining.toString()).toBe("0");
  });

  test("linked excess flows FIFO to the next open leg", () => {
    const m = allocate([
      entry(1, T("SELL", 10, "USDT", 1_000_000)),
      entry(2, T("SELL", 5, "USDT", 1_000_000)),
      entry(3, T("RECEIVE", 8_000_000, "IRT"), 2),
    ]);
    expect(m.get(2)?.[1].remaining.toString()).toBe("0");
    expect(m.get(1)?.[1].remaining.toString()).toBe("7000000");
  });

  test("PAY reduces we_owe only, RECEIVE client_owes only", () => {
    const deal = entry(1, T("BUY", 100, "USDT", 1000)); // client owes USDT, we owe IRT
    // wrong-direction payments change nothing
    expect(rem(allocate([deal, entry(2, T("PAY", 100, "USDT"))]).get(1))).toEqual([
      "client_owes:USDT:100",
      "we_owe:IRT:100000",
    ]);
    expect(rem(allocate([deal, entry(2, T("RECEIVE", 100_000, "IRT"))]).get(1))).toEqual([
      "client_owes:USDT:100",
      "we_owe:IRT:100000",
    ]);
    // right-direction payments reduce
    const ok = allocate([deal, entry(2, T("PAY", 40_000, "IRT")), entry(3, T("RECEIVE", 30, "USDT"))]);
    expect(rem(ok.get(1))).toEqual(["client_owes:USDT:70", "we_owe:IRT:60000"]);
  });

  test("unpriced BUY has only the asset leg", () => {
    expect(rem(allocate([entry(1, T("BUY", 50))]).get(1))).toEqual(["client_owes:USDT:50"]);
  });

  test("overpayment leaves legs at zero; excess shows only in summarize", () => {
    const entries = [
      entry(1, T("SELL", 10, "USDT", 1_000_000)),
      entry(2, T("RECEIVE", 50_000_000, "IRT")),
    ];
    expect(rem(allocate(entries).get(1))).toEqual(["we_owe:USDT:10", "client_owes:IRT:0"]);
    expect(owed(entries.map((e) => e.trade))).toEqual(["USDT=-10", "IRT=-40000000"]);
  });
});

test("openDeals lists open trades oldest first", () => {
  const open = openDeals([
    entry(1, T("SELL", 10, "USDT", 1_000_000)),
    entry(2, T("SELL", 10, "USDT", 1_000_000)),
    entry(3, T("RECEIVE", 10_000_000, "IRT"), 1),
  ]);
  expect(open.map((d) => d.id)).toEqual([1, 2]); // deal 1 still has its USDT leg open
  expect(openDeals([entry(1, T("BUY", 5)), entry(2, T("RECEIVE", 5, "USDT"))])).toEqual([]);
});
