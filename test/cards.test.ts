import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  editKeyboard,
  entryKeyboard,
  jalali,
  renderBalance,
  renderEntry,
  renderTxScan,
  txPickerKeyboard,
  renderList,
  renderReminder,
  renderSettlement,
  settlementKeyboard,
} from "../src/cards";
import { dealCode, type Entry, type TxMeta } from "../src/db";
import { fa } from "../src/money";
import { debts, openDeals, summarize } from "../src/ledger";
import { createTg, isForbidden, TgError } from "../src/telegram";
import type { Trade } from "../src/trade";
import { CLIENT_WRITE_REFUSALS, NUDGE_LINES, ORDINARY_LINES, pick } from "../src/jokes";
import { FakeTg } from "./fakes";

const D = (s: string | number) => new Decimal(s);

const trade = (over: Partial<Trade> = {}): Trade => ({
  side: "BUY",
  amount: D(1000),
  asset: "USDT",
  rate: D(266000),
  note: "",
  tomanTotal: null,
  ...over,
});

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: 7,
  chatId: -100,
  code: dealCode(7),
  trade: trade(),
  status: "pending",
  batchId: null,
  linkedDealId: null,
  cardMsgId: null,
  joke: null,
  createdBy: "Ali",
  createdById: 1,
  createdAt: "2026-10-17T19:05:00+03:30",
  decidedBy: null,
  decidedAt: null,
  cancelledBy: null,
  cancelledAt: null,
  tx: null,
  ...over,
});

describe("jalali", () => {
  it("formats Tehran time in the Persian calendar", () => {
    expect(jalali("2026-10-17T19:05:00+03:30")).toBe("۱۴۰۵/۰۷/۲۵ – ۱۹:۰۵");
  });
});

describe("renderEntry", () => {
  it("shows the toman breakdown for a by-toman trade", () => {
    const t = trade({ amount: D("1893.94"), rate: D(264000), tomanTotal: D(500000000) });
    expect(renderEntry(entry({ trade: t }))).toContain("۵۰۰٬۰۰۰٬۰۰۰ ÷ ۲۶۴٬۰۰۰");
  });

  it("never shows the Nobitex price on a deal card (owner request)", () => {
    expect(renderEntry(entry())).not.toContain("نوبیتکس");
  });

  it("escapes user-supplied text", () => {
    const html = renderEntry(entry({ trade: trade({ note: "<b>x</b>" }), createdBy: "<i>Bob" }));
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;Bob");
  });

  it("appends the joke in italics before the status", () => {
    const html = renderEntry(entry({ joke: "شوخی <u>" }));
    expect(html).toContain("<i>شوخی &lt;u&gt;</i>");
    expect(html.indexOf("شوخی")).toBeLessThan(html.indexOf("وضعیت"));
  });
});

describe("keyboards", () => {
  const cbs = (k: ReturnType<typeof entryKeyboard>) =>
    k?.inline_keyboard.flat().map((b) => b.callback_data);

  it("pending has ok/no/cx", () => {
    expect(cbs(entryKeyboard(entry()))).toEqual(["ok:7", "no:7", "cx:7"]);
  });
  it("approved has cx; confirmCancel has cy/cn", () => {
    expect(cbs(entryKeyboard(entry({ status: "approved" })))).toEqual(["cx:7"]);
    expect(cbs(entryKeyboard(entry({ status: "approved" }), true))).toEqual(["cy:7", "cn:7"]);
  });
  it("settled entries have none", () => {
    expect(entryKeyboard(entry({ status: "rejected" }))).toBeNull();
  });
  it("settlement and edit keyboards", () => {
    expect(settlementKeyboard(5).inline_keyboard.flat().map((b) => b.callback_data)).toEqual(["ok:5", "no:5"]);
    expect(editKeyboard(9).inline_keyboard.flat().map((b) => b.callback_data)).toEqual(["ea:9", "ed:9"]);
  });
});

describe("renderReminder / renderBalance", () => {
  const acc = summarize([trade()]); // client owes 1000 USDT, we owe 266,000,000 toman

  it("lists both what the client owes and what we owe", () => {
    const out = renderReminder("گروه", acc, [], "یادآوری");
    expect(out).toContain("۱٬۰۰۰");
    expect(out).toContain("تتر");
    expect(out).toContain("۲۶۶٬۰۰۰٬۰۰۰");
    expect(out).toContain("تومان");
    expect(out).toContain("ما هم");
  });

  it("omits the we-owe line when we owe nothing", () => {
    const only = summarize([trade({ rate: null })]);
    expect(renderReminder("گروه", only, [], "یادآوری")).not.toContain("ما هم");
  });

  it("says settled for a fully settled account", () => {
    const settled = summarize([trade(), trade({ side: "RECEIVE", rate: null, asset: "USDT" }), trade({ side: "PAY", rate: null, asset: "IRT", amount: D(266000000) })]);
    expect(renderBalance("گروه", settled)).toContain("تسویه شده");
  });
});

describe("renderBalance: simple per-currency card (owner's sample)", () => {
  // BUY 1000 USDT @ 266,000: client owes us 1000 USDT, we owe them 266,000,000 toman.
  const out = renderBalance("PINGI | SHARIATI", summarize([trade()]));

  it("one line per currency, from the client's side: minus = بدهکار, plus = بستانکار", () => {
    const lines = out.split("\n");
    const irt = lines.find((l) => l.includes("IRT"))!;
    const usdt = lines.find((l) => l.includes("USDT"))!;
    expect(usdt).toContain("-۱٬۰۰۰");
    expect(usdt).toContain("بدهکار");
    expect(irt).toContain("۲۶۶٬۰۰۰٬۰۰۰");
    expect(irt).not.toContain("-");
    expect(irt).toContain("بستانکار");
    expect(lines.indexOf(irt)).toBeLessThan(lines.indexOf(usdt)); // IRT first, like the sample
  });

  it("drops the deal list, trade stats and payments sections", () => {
    for (const gone of ["معاملات باز", "میانگین", "پرداخت‌ها", "📊", "ثبت پرداخت"]) expect(out).not.toContain(gone);
    expect(out.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("always shows IRT and USDT, zero as تسویه شده", () => {
    const usdtOnly = renderBalance("گ", summarize([trade({ rate: null })])); // only a USDT leg
    const irt = usdtOnly.split("\n").find((l) => l.includes("IRT"))!;
    expect(irt).toContain("۰");
    expect(irt).toContain("تسویه شده");
  });

  it("other touched currencies get their own line", () => {
    expect(renderBalance("گ", summarize([trade({ asset: "BTC", amount: D(2), rate: null })]))).toContain("BTC");
  });

  it("escapes the group name and keeps the empty-account message", () => {
    expect(out).toContain("PINGI | SHARIATI");
    expect(renderBalance("<b>x</b>", summarize([]))).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(renderBalance("گ", summarize([]))).toContain("وجود ندارد");
  });
});

describe("Telegram's 4096-char limit", () => {
  // 60 approved deals with mixed legs, none settled: every one of them is open.
  const ledger = Array.from({ length: 60 }, (_, i) => ({
    id: 1000 + i,
    trade: trade({ amount: D(1000 + i), asset: i % 2 ? "USDT" : "BTC", rate: D(266000 + i) }),
    linkedDealId: null,
  }));
  const acc = summarize(ledger.map((l) => l.trade));
  const open = openDeals(ledger);

  it("balance stays short no matter how many deals are open", () => {
    expect(open).toHaveLength(60);
    const out = renderBalance("گروه بزرگ", acc);
    expect(out.length).toBeLessThan(500);
    expect(out).not.toContain(dealCode(1000));
  });

  it("caps open deals but keeps the totals (reminder)", () => {
    const out = renderReminder("گروه بزرگ", acc, open, "یادآوری");
    expect(out.length).toBeLessThan(4096);
    expect(out).toContain("و ۴۵ مورد دیگر");
    expect(out).toContain("بدهکارید");
  });

  it("a short reminder list is not capped", () => {
    expect(renderReminder("گ", acc, open.slice(0, 3), "یادآوری")).not.toContain("مورد دیگر");
  });
});

describe("group name escaping", () => {
  const name = "<b>g</b>";
  const acc = summarize([trade()]);
  const outputs: [string, string][] = [
    ["renderList", renderList(name, [entry()])],
    ["renderList (empty)", renderList(name, [])],
    ["renderBalance", renderBalance(name, acc)],
    ["renderReminder", renderReminder(name, acc, [], "x")],
  ];
  it.each(outputs)("%s escapes the name", (_n, out) => {
    expect(out).toContain("&lt;b&gt;g&lt;/b&gt;");
    expect(out).not.toContain("<b>g</b>");
  });
});

describe("jokes", () => {
  it("has enough lines and picks deterministically", () => {
    for (const l of [ORDINARY_LINES, NUDGE_LINES, CLIENT_WRITE_REFUSALS]) expect(l.length).toBeGreaterThanOrEqual(8);
    expect(pick(ORDINARY_LINES, 13)).toBe(ORDINARY_LINES[13 % ORDINARY_LINES.length]);
  });

  it("no line touches ethnicity (owner's hard line)", () => {
    expect(ORDINARY_LINES).toContain("حساب حساب است، داداش! 😄");
    for (const l of [ORDINARY_LINES, NUDGE_LINES, CLIENT_WRITE_REFUSALS].flat()) expect(l).not.toContain("کاکا");
  });
});

describe("telegram client", () => {
  it("parses TgError from an ok:false response", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: group chat was upgraded to a supergroup chat",
          parameters: { migrate_to_chat_id: -100123 },
        }),
      )) as unknown as typeof fetch;
    const err = await createTg("T", f).call("sendMessage", {}).catch((e) => e);
    expect(err).toBeInstanceOf(TgError);
    expect(err.code).toBe(400);
    expect(err.migrateTo).toBe(-100123);
  });

  it("isForbidden covers 403 and chat not found", () => {
    expect(isForbidden(new TgError(403, "Forbidden: bot was blocked"))).toBe(true);
    expect(isForbidden(new TgError(400, "Bad Request: chat not found"))).toBe(true);
    expect(isForbidden(new TgError(400, "other"))).toBe(false);
  });

  it("returns result on success and posts to the bot URL", async () => {
    let url = "";
    const f = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }));
    }) as unknown as typeof fetch;
    expect(await createTg("TOK", f).call("sendMessage", { chat_id: 1 })).toEqual({ message_id: 3 });
    expect(url).toBe("https://api.telegram.org/botTOK/sendMessage");
  });
});

describe("FakeTg", () => {
  it("records calls, numbers messages, scripts replies and failures", async () => {
    const tg = new FakeTg();
    expect(await tg.call("sendMessage", { chat_id: 1 })).toEqual({ message_id: 1 });
    expect(await tg.call("sendMessage", { chat_id: 1 })).toEqual({ message_id: 2 });
    tg.reply("getMe", () => ({ id: 5 }));
    expect(await tg.call("getMe", {})).toEqual({ id: 5 });
    tg.fail("sendMessage", 9, new TgError(403, "blocked"));
    await expect(tg.call("sendMessage", { chat_id: 9 })).rejects.toBeInstanceOf(TgError);
    expect(tg.calls).toHaveLength(4);
  });
});

describe("renderSettlement", () => {
  const payment = (over: Partial<Entry> = {}) =>
    entry({ id: 8, trade: trade({ side: "RECEIVE", rate: null }), linkedDealId: 7, ...over });
  const deal = entry({ status: "approved", decidedBy: "Boss", decidedAt: "2026-10-17T19:00:00+03:30" });

  it("shows the payments' status, not the deal's", () => {
    const out = renderSettlement(deal, [payment()]);
    expect(out).toContain("در انتظار تایید");
    expect(out).not.toContain("توسط Boss");
  });
  it("shows approved and rejected payments with who decided", () => {
    const decided = { decidedBy: "Sina", decidedAt: "2026-10-17T20:00:00+03:30" };
    expect(renderSettlement(deal, [payment({ status: "approved", ...decided })])).toContain("تایید شد");
    const rejected = renderSettlement(deal, [payment({ status: "rejected", ...decided })]);
    expect(rejected).toContain("رد شد");
    expect(rejected).toContain("رد توسط Sina");
  });
});

describe("transaction scan cards", () => {
  const TRON_HASH = "e9eb6c53b09f9f7b502dd31f7e1200c17e97b3b3c01884087f0900a4e52ad94a";
  const meta = (over: Partial<TxMeta> = {}): TxMeta => ({
    network: "TRON",
    hash: TRON_HASH,
    counterparty: "TWTV2WWNBZ9crFQyv1mnoFTDi25YDrjsBZ",
    confirmations: 2,
    final: false,
    fee: D("6.7735"),
    feeAsset: "TRX",
    warnings: ["تراکنش هنوز <قطعی> نشده"],
    ...over,
  });
  const receive = trade({ side: "RECEIVE", rate: null });

  it("RECEIVE entry with tx shows explorer link, short counterparty, fee and warnings", () => {
    const html = renderEntry(entry({ trade: receive, tx: meta(), linkedDealId: 3 }));
    expect(html).toContain(`href="https://tronscan.org/#/transaction/${TRON_HASH}"`);
    expect(html).toContain("TWTV2W…jsBZ");
    expect(html).toContain(fa(D("6.7735")));
    expect(html).toContain("TRX");
    expect(html).toContain(dealCode(3));
    expect(html).toContain("⚠️ تراکنش هنوز &lt;قطعی&gt; نشده");
    expect(html).not.toContain("<قطعی>");
  });

  it("entry without tx has no tx block", () => {
    expect(renderEntry(entry({ trade: receive }))).not.toContain("tronscan");
  });

  it("renderTxScan shows amount, tx block, note and asks which deal", () => {
    const html = renderTxScan(
      { id: 4, chatId: -100, side: "RECEIVE", amount: D(1000), meta: meta({ warnings: [] }), createdBy: "c", createdById: 2,
        sourceMsgId: 1, createdAt: "2026-11-08T12:00:00+03:30", status: "pending" },
      "یادداشت <x>",
    );
    expect(html).toContain(fa(D(1000)));
    expect(html).toContain("tronscan.org");
    expect(html).toContain("یادداشت &lt;x&gt;");
    expect(html).toContain("کدام معامله");
  });

  it("picker keyboard: at most 8 deals then the no-deal button; callback_data fits 64 bytes", () => {
    const deals = Array.from({ length: 10 }, (_, i) => ({ id: 100000 + i, code: dealCode(100000 + i), remaining: D("1234.56") }));
    const kb = txPickerKeyboard(987654321, deals);
    expect(kb.inline_keyboard).toHaveLength(9);
    expect(kb.inline_keyboard[0][0].callback_data).toBe("tp:987654321:100000");
    expect(kb.inline_keyboard[8][0]).toEqual({ text: "بدون معامله", callback_data: "tp:987654321:0" });
    for (const row of kb.inline_keyboard) for (const b of row) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
  });
});
