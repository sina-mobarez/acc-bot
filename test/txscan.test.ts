import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import type { TxInfo } from "../src/chain";
import { dealCode, type Entry } from "../src/db";
import type { Leg } from "../src/ledger";
import type { Trade } from "../src/trade";
import {
  AMBIGUOUS, AMOUNT_MISMATCH, classify, DEAL_NOT_APPROVED, DEAL_SETTLED, dealFit, FAILED, NO_WALLET, NOT_FINAL,
  NOT_OURS, NOT_USDT, parseWallet, warnings,
} from "../src/txscan";

const D = (s: string | number) => new Decimal(s);
const OURS_TRON = "TFxi6L2JoLudi9Y22nRJ9xtTHTCGpkGfT4";
const CLIENT_TRON = "TWTV2WWNBZ9crFQyv1mnoFTDi25YDrjsBZ";
const OURS_BSC = "0x7c9e2d0cb5ec9ea82ddffd35bb4a1cb65d487809";
const CLIENT_BSC = "0xa010ec4e43c6448f2fe13340991bededf8763bf4";

const tx = (over: Partial<TxInfo> = {}): TxInfo => ({
  network: "TRON",
  hash: "ab".repeat(32),
  succeeded: true,
  transfers: [{ from: CLIENT_TRON, to: OURS_TRON, amount: D(1000) }],
  confirmations: 30,
  final: true,
  fee: D("6.7735"),
  feeAsset: "TRX",
  ...over,
});

const trade = (over: Partial<Trade> = {}): Trade => ({
  side: "BUY", amount: D(1000), asset: "USDT", rate: D(266000), note: "", tomanTotal: null, ...over,
});

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: 7, chatId: -100, code: dealCode(7), trade: trade(), status: "approved", batchId: null, linkedDealId: null,
  cardMsgId: 1, joke: null, createdBy: "a", createdById: 1, createdAt: "2026-11-08T12:00:00+03:30", decidedBy: null,
  decidedAt: null, cancelledBy: null, cancelledAt: null, tx: null, ...over,
});

const leg = (remaining: string | number): Leg => ({ asset: "USDT", dir: "client_owes", total: D(1000), remaining: D(remaining) });

describe("parseWallet", () => {
  test("BSC is lowercased; bad length is null", () => {
    expect(parseWallet("BSC", " 0x7C9E2D0CB5EC9EA82DDFFD35BB4A1CB65D487809 ")).toBe(OURS_BSC);
    expect(parseWallet("BSC", "0x7c9e2d0cb5ec9ea82ddffd35bb4a1cb65d48780")).toBeNull();
    expect(parseWallet("BSC", OURS_TRON)).toBeNull();
  });
  test("TRON is kept exact; 33 chars or bad alphabet is null", () => {
    expect(parseWallet("TRON", OURS_TRON)).toBe(OURS_TRON);
    expect(parseWallet("TRON", OURS_TRON.slice(0, 33))).toBeNull();
    expect(parseWallet("TRON", `${OURS_TRON.slice(0, 33)}0`)).toBeNull();
    expect(parseWallet("TRON", OURS_BSC)).toBeNull();
  });
});

describe("classify", () => {
  test("no wallet, failed, not USDT, not ours", () => {
    expect(classify(tx(), null)).toEqual({ kind: "refuse", text: NO_WALLET("TRON") });
    expect(classify(tx({ succeeded: false }), OURS_TRON)).toEqual({ kind: "refuse", text: FAILED });
    expect(classify(tx({ transfers: [] }), OURS_TRON)).toEqual({ kind: "refuse", text: NOT_USDT });
    expect(classify(tx(), "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj")).toEqual({ kind: "refuse", text: NOT_OURS });
  });
  test("incoming is RECEIVE, two incoming transfers sum", () => {
    const r = classify(tx({ transfers: [
      { from: CLIENT_TRON, to: OURS_TRON, amount: D("600.5") },
      { from: CLIENT_TRON, to: OURS_TRON, amount: D("399.5") },
    ] }), OURS_TRON);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.side).toBe("RECEIVE");
    expect(r.amount.eq(1000)).toBe(true);
    expect(r.counterparty).toBe(CLIENT_TRON);
  });
  test("outgoing is PAY (BSC wallet saved mixed case, then parsed)", () => {
    const wallet = parseWallet("BSC", "0x7C9e2d0cb5ec9ea82ddffd35bb4a1cb65d487809");
    const r = classify(tx({ network: "BSC", transfers: [{ from: OURS_BSC, to: CLIENT_BSC, amount: D(97) }] }), wallet);
    expect(r).toMatchObject({ kind: "ok", side: "PAY", counterparty: CLIENT_BSC });
  });
  test("both directions is ambiguous; a self-transfer alone is not ours", () => {
    expect(classify(tx({ transfers: [
      { from: CLIENT_TRON, to: OURS_TRON, amount: D(5) },
      { from: OURS_TRON, to: CLIENT_TRON, amount: D(5) },
    ] }), OURS_TRON)).toEqual({ kind: "refuse", text: AMBIGUOUS });
    expect(classify(tx({ transfers: [{ from: OURS_TRON, to: OURS_TRON, amount: D(5) }] }), OURS_TRON))
      .toEqual({ kind: "refuse", text: NOT_OURS });
  });
});

describe("dealFit", () => {
  test("BUY USDT takes RECEIVE, SELL USDT takes PAY", () => {
    expect(dealFit(entry(), "RECEIVE")).toBe(true);
    expect(dealFit(entry(), "PAY")).toBe(false);
    expect(dealFit(entry({ trade: trade({ side: "SELL" }) }), "PAY")).toBe(true);
  });
  test("payments and non-USDT deals never fit", () => {
    expect(dealFit(entry({ trade: trade({ side: "RECEIVE", rate: null }) }), "RECEIVE")).toBe(false);
    expect(dealFit(entry({ trade: trade({ asset: "BTC" }) }), "RECEIVE")).toBe(false);
  });
});

describe("warnings", () => {
  const base = { final: true, network: "TRON" as const, confirmations: 30, amount: D(1000), deal: null, leg: null };
  test("nothing to say for a final transfer with no deal", () => {
    expect(warnings(base)).toEqual([]);
  });
  test("not final mentions the count", () => {
    expect(warnings({ ...base, final: false, confirmations: 2 })).toEqual([NOT_FINAL("TRON", 2)]);
  });
  test("deal not approved; approved but settled", () => {
    expect(warnings({ ...base, deal: entry({ status: "pending" }) })).toEqual([DEAL_NOT_APPROVED]);
    expect(warnings({ ...base, deal: entry(), leg: null })).toEqual([DEAL_SETTLED]);
    expect(warnings({ ...base, deal: entry(), leg: leg(0) })).toEqual([DEAL_SETTLED]);
  });
  test("mismatch from 0.01 USDT up", () => {
    expect(warnings({ ...base, amount: D("99.995"), deal: entry(), leg: leg(100) })).toEqual([]);
    expect(warnings({ ...base, amount: D("99.99"), deal: entry(), leg: leg(100) })).toEqual([AMOUNT_MISMATCH(D("99.99"), D(100))]);
    expect(warnings({ ...base, amount: D(150), deal: entry(), leg: leg(100) })).toEqual([AMOUNT_MISMATCH(D(150), D(100))]);
  });
});
