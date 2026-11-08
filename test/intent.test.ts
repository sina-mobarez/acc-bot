import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import { deviationPct, expandRateShorthand, toAction } from "../src/intent";
import type { NluOutput } from "../src/nlu";

const dec = (s: string) => new Decimal(s);
const admin = { role: "admin" as const, usdtToman: dec("266001"), defaultAsset: "USDT" };

describe("toAction", () => {
  test("query_remaining maps to remaining, allowed for clients", () => {
    expect(toAction({ intent: "query_remaining" }, admin)).toEqual({ kind: "remaining", dealCode: undefined });
    expect(toAction({ intent: "query_remaining", deal_code: "D-00012" }, { ...admin, role: "client" })).toEqual({
      kind: "remaining",
      dealCode: "D-00012",
    });
  });

  test("create_trade", () => {
    const a = toAction(
      { intent: "create_trade", side: "BUY", amount_text: "۱۰۰", asset: "تتر", rate_text: "۲۷۵ هزار" },
      admin,
    );
    if (a.kind !== "create") throw new Error("expected create");
    expect(a.trade.side).toBe("BUY");
    expect(a.trade.asset).toBe("USDT");
    expect(a.trade.amount.equals(100)).toBe(true);
    expect(a.trade.rate!.equals(275000)).toBe(true);
    expect(a.trade.tomanTotal).toBeNull();
  });

  test("amount and rate with trailing unit words still parse", () => {
    const a = toAction(
      { intent: "create_trade", side: "BUY", amount_text: "۱۰۰ تا", asset: "تتر", rate_text: "۲۷۶" },
      { ...admin, usdtToman: dec("266000") },
    );
    if (a.kind !== "create") throw new Error("expected create");
    expect(a.trade.side).toBe("BUY");
    expect(a.trade.asset).toBe("USDT");
    expect(a.trade.amount.equals(100)).toBe(true);
    expect(a.trade.rate!.equals(276000)).toBe(true);
  });

  test("toman amount converts via fromToman and keeps tomanTotal", () => {
    const a = toAction(
      { intent: "create_trade", side: "BUY", amount_text: "۵۰۰ میلیون", amount_unit: "toman", rate_text: "۲۶۴۰۰۰" },
      admin,
    );
    if (a.kind !== "create") throw new Error("expected create");
    expect(a.trade.amount.toString()).toBe("1893.94");
    expect(a.trade.tomanTotal!.equals(500000000)).toBe(true);
    expect(a.trade.asset).toBe("USDT");
  });

  test("toman amount without rate asks", () => {
    const a = toAction(
      { intent: "create_trade", side: "BUY", amount_text: "۵۰۰ میلیون", amount_unit: "toman" },
      admin,
    );
    expect(a.kind).toBe("reply");
  });

  test("rate shorthand expands only with a reference price", () => {
    const o: NluOutput = { intent: "create_trade", side: "SELL", amount_text: "10", rate_text: "۲۷۵" };
    const a = toAction(o, admin);
    if (a.kind !== "create") throw new Error("expected create");
    expect(a.trade.rate!.equals(275000)).toBe(true);
    const b = toAction(o, { ...admin, usdtToman: null });
    if (b.kind !== "create") throw new Error("expected create");
    expect(b.trade.rate!.equals(275)).toBe(true);
  });

  test("unparsable amount -> Persian clarifying reply", () => {
    const a = toAction({ intent: "create_trade", side: "BUY", amount_text: "کلی پول" }, admin);
    if (a.kind !== "reply") throw new Error("expected reply");
    expect(a.text).toMatch(/[؀-ۿ]/);
  });

  test.each(["create_trade", "record_payment", "settle_deal", "edit_deal", "cancel_deal"] as const)(
    "client write %s is refused",
    (intent) => {
      const a = toAction(
        { intent, side: "BUY", direction: "PAY", amount_text: "10", deal_code: "D-00001" },
        { ...admin, role: "client" },
      );
      expect(a).toEqual({ kind: "refuse" });
    },
  );

  test("client may query", () => {
    expect(toAction({ intent: "query_balance" }, { ...admin, role: "client" }).kind).toBe("balance");
  });

  test.each([
    ["query_balance", "balance"],
    ["query_deals", "deals"],
  ] as const)("%s: clientHint dropped for clients, kept for admins", (intent, kind) => {
    const o: NluOutput = { intent, client_hint: "B" };
    const c = toAction(o, { ...admin, role: "client" });
    expect(c.kind).toBe(kind);
    expect((c as { clientHint?: string }).clientHint).toBeUndefined();
    expect(toAction(o, admin)).toEqual({ kind, clientHint: "B" });
  });

  test("record_payment defaults to toman", () => {
    const a = toAction({ intent: "record_payment", direction: "RECEIVE", amount_text: "۱۰۰ میلیون" }, admin);
    if (a.kind !== "payment") throw new Error("expected payment");
    expect(a.trade.asset).toBe("IRT");
    expect(a.trade.side).toBe("RECEIVE");
    expect(a.trade.amount.equals(100000000)).toBe(true);
    expect(a.trade.rate).toBeNull();
  });

  test("edit, settle, cancel, queries, chitchat", () => {
    const e = toAction(
      { intent: "edit_deal", deal_code: "D-00012", changes: { rate_text: "۲۷۰ هزار", note: "x" } },
      admin,
    );
    if (e.kind !== "edit") throw new Error("expected edit");
    expect(e.changes.rate!.equals(270000)).toBe(true);
    expect(e.changes.note).toBe("x");
    expect(toAction({ intent: "settle_deal", deal_code: "D-00012" }, admin)).toEqual({
      kind: "settle",
      dealCode: "D-00012",
    });
    expect(toAction({ intent: "cancel_deal" }, admin).kind).toBe("reply");
    expect(toAction({ intent: "query_price", coins: ["BTC"] }, admin)).toEqual({ kind: "price", coins: ["BTC"] });
    expect(toAction({ intent: "chitchat", reply: "سلام" }, admin)).toEqual({ kind: "reply", text: "سلام" });
  });
});

describe("helpers", () => {
  test("expandRateShorthand bounds", () => {
    expect(expandRateShorthand(dec("275"), "USDT", dec("266001")).equals(275000)).toBe(true);
    expect(expandRateShorthand(dec("275"), "USDT", null).equals(275)).toBe(true);
    expect(expandRateShorthand(dec("275"), "USD", dec("266001")).equals(275)).toBe(true);
    expect(expandRateShorthand(dec("50"), "USDT", dec("266001")).equals(50)).toBe(true);
    expect(expandRateShorthand(dec("275000"), "USDT", dec("266001")).equals(275000)).toBe(true);
  });

  test("deviationPct", () => {
    expect(deviationPct(dec("280000"), dec("266000")).toString()).toBe("5.3");
  });
});
