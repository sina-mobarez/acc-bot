import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import type { Message } from "@grammyjs/types";
import { describe, expect, test } from "vitest";
import { renderBalance } from "../src/cards";
import {
  approvedLedger,
  createEntry,
  getEntry,
  recent,
  setSetting,
  transition,
  upsertAccount,
  type Entry,
} from "../src/db";
import { handleMessage } from "../src/handlers/message";
import { BUSY_TEXT, CLIENT_WRITE_REFUSALS, ORDINARY_LINES, pick } from "../src/jokes";
import { openDeals, summarize } from "../src/ledger";
import type { NluOutput } from "../src/nlu";
import type { Trade } from "../src/trade";
import { FakeNlu, fakeFetch, FIXED_NOW, makeApp, type TestApp } from "./fakes";

const db = env.DB;
const D = (s: string | number) => new Decimal(s);
const ADMIN = { id: 1, is_bot: false, first_name: "Sina", username: "sina" };
const CLIENT = { id: 7, is_bot: false, first_name: "Ali" };
const BOT = { id: 99, is_bot: true, first_name: "Bot" };

const NOBITEX = {
  status: "ok",
  stats: { "usdt-rls": { latest: "2660000", bestBuy: "2659000", bestSell: "2661000" } },
};
const prices = (extra: Record<string, unknown> = {}) =>
  fakeFetch({ "apiv2.nobitex.ir": NOBITEX, ...extra });

let nextChat = 5000;
const freshGroup = () => ({ id: -(++nextChat), type: "supergroup" as const, title: `G${nextChat}` });
let nextMsg = 100;

function msg(chat: Message["chat"], from: typeof ADMIN | typeof CLIENT, text: string, over: object = {}): Message {
  return { message_id: ++nextMsg, date: 0, chat, from, text, ...over } as unknown as Message;
}

function app(nlu: FakeNlu = new FakeNlu(), f: typeof fetch = prices()): TestApp {
  return makeApp({ nlu, fetch: f });
}

const sent = (a: TestApp) => a.tg.calls.filter((c) => c.method === "sendMessage");
const lastText = (a: TestApp) => String(sent(a).at(-1)!.params.text);
const lastButtons = (a: TestApp): string[] =>
  ((sent(a).at(-1)!.params.reply_markup as any)?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data);

const trade = (over: Partial<Trade> = {}): Trade => ({
  side: "SELL",
  amount: D(1000),
  asset: "USDT",
  rate: D(266000),
  note: "",
  tomanTotal: null,
  ...over,
});

async function approved(chatId: number, t: Trade, linkedDealId: number | null = null): Promise<Entry> {
  const e = await createEntry(db, {
    chatId, trade: t, linkedDealId, createdBy: "@sina", createdById: 1, createdAt: FIXED_NOW,
  });
  await transition(db, [e.id], "pending", "approved", { decidedBy: "@sina", decidedAt: FIXED_NOW });
  return (await getEntry(db, e.id))!;
}

const nlu = (...o: (NluOutput | null)[]) => new FakeNlu(...o);

describe("fast path", () => {
  test("# admin trade creates pending card", async () => {
    const chat = freshGroup();
    const a = app();
    const m = msg(chat, ADMIN, "#خرید ۱۰۰۰ تتر ۲۶۶۰۰۰");
    await handleMessage(a, m, m.text!);

    const [e] = await recent(db, chat.id, 5);
    expect(e.status).toBe("pending");
    expect(e.trade.side).toBe("BUY");
    expect(e.trade.amount.eq(1000)).toBe(true);
    expect(e.createdBy).toBe("@sina");
    expect(e.joke).toBe(pick(ORDINARY_LINES, m.message_id));
    const call = sent(a)[0].params;
    expect(call.chat_id).toBe(chat.id);
    expect(call.parse_mode).toBe("HTML");
    expect(call.reply_parameters).toEqual({ message_id: m.message_id });
    expect(lastButtons(a)).toContain(`ok:${e.id}`);
    expect(lastText(a)).toContain("قیمت نوبیتکس");
    expect(e.cardMsgId).toBe(1); // FakeTg's first message_id
    expect(a.nlu.inputs).toHaveLength(0); // no deviation, no Gemini call
  });

  test("# payment creates pending payment card", async () => {
    const chat = freshGroup();
    const a = app();
    const m = msg(chat, ADMIN, "#دریافت ۵۰ میلیون تومن");
    await handleMessage(a, m, m.text!);
    const [e] = await recent(db, chat.id, 5);
    expect(e.trade.side).toBe("RECEIVE");
    expect(e.trade.asset).toBe("IRT");
    expect(e.trade.amount.eq(50_000_000)).toBe(true);
    expect(lastButtons(a)).toContain(`ok:${e.id}`);
  });

  test("# trade with 5% deviation shows warning and asks nlu for a joke", async () => {
    const chat = freshGroup();
    const a = app(nlu({ intent: "create_trade", joke: "گرون <b>فروشی</b>" }));
    const m = msg(chat, ADMIN, "#فروش ۱۰۰ تتر ۲۷۹۳۰۰");
    await handleMessage(a, m, m.text!);

    expect(a.nlu.inputs).toHaveLength(1);
    expect(a.nlu.inputs[0].deviationPct).toBe("3");
    expect(a.nlu.inputs[0].usdtToman).toBe("266000");
    const text = lastText(a);
    expect(text).toContain("⚠️");
    expect(text).toContain("+۵٪");
    expect(text).toContain("گرون &lt;b&gt;فروشی&lt;/b&gt;");
    const [e] = await recent(db, chat.id, 5);
    expect(e.joke).toBe("گرون <b>فروشی</b>");
  });

  test("deviation threshold comes from the deviation_pct setting", async () => {
    await setSetting(db, "deviation_pct", "10");
    try {
      const chat = freshGroup();
      const a = app(nlu({ intent: "create_trade", joke: "x" }));
      const m = msg(chat, ADMIN, "#فروش ۱۰۰ تتر ۲۷۹۳۰۰");
      await handleMessage(a, m, m.text!);
      expect(a.nlu.inputs).toHaveLength(0);
      expect(lastText(a)).not.toContain("⚠️");
    } finally {
      await setSetting(db, "deviation_pct", "3");
    }
  });

  test("an unparseable deviation_pct falls back to 3 instead of crashing (R20)", async () => {
    await setSetting(db, "deviation_pct", "garbage");
    try {
      const chat = freshGroup();
      const a = app(nlu({ intent: "create_trade", joke: "x" }));
      const m = msg(chat, ADMIN, "#فروش ۱۰۰ تتر ۲۷۹۳۰۰");
      await handleMessage(a, m, m.text!);
      expect(await recent(db, chat.id, 5)).toHaveLength(1);
    } finally {
      await setSetting(db, "deviation_pct", "3");
    }
  });

  test("humor off: no joke and no Gemini call", async () => {
    const chat = freshGroup();
    await upsertAccount(db, { chatId: chat.id, title: chat.title, type: chat.type, at: FIXED_NOW });
    await db.prepare("UPDATE accounts SET humor_on = 0 WHERE chat_id = ?").bind(chat.id).run();
    const a = app(nlu({ intent: "create_trade", joke: "x" }));
    const m = msg(chat, ADMIN, "#فروش ۱۰۰ تتر ۲۷۹۳۰۰");
    await handleMessage(a, m, m.text!);
    expect(a.nlu.inputs).toHaveLength(0);
    const [e] = await recent(db, chat.id, 5);
    expect(e.joke).toBeNull();
  });

  test("TradeError is replied", async () => {
    const chat = freshGroup();
    const a = app();
    const m = msg(chat, ADMIN, "#خرید ۵۰۰ میلیون تومان تتر");
    await handleMessage(a, m, m.text!);
    expect(lastText(a)).toContain("قیمت لازم است");
    expect(await recent(db, chat.id, 5)).toHaveLength(0);
  });

  test("nobitex down → card without reference", async () => {
    const chat = freshGroup();
    const a = app(nlu(), fakeFetch({ "apiv2.nobitex.ir": 500 }));
    const m = msg(chat, ADMIN, "#خرید ۱۰۰۰ تتر ۲۶۶۰۰۰");
    await handleMessage(a, m, m.text!);
    expect(await recent(db, chat.id, 5)).toHaveLength(1);
    expect(lastText(a)).not.toContain("نوبیتکس");
    expect(a.nlu.inputs).toHaveLength(0);
  });
});

describe("refusals and fallbacks", () => {
  test("client write is refused", async () => {
    const chat = freshGroup();
    const a = app(nlu({ intent: "create_trade", side: "BUY", amount_text: "۱۰۰" }));
    const m1 = msg(chat, CLIENT, "#خرید ۱۰ تتر ۲۶۶۰۰۰");
    await handleMessage(a, m1, m1.text!);
    expect(CLIENT_WRITE_REFUSALS).toContain(lastText(a));
    const m2 = msg(chat, CLIENT, "۱۰۰ تتر بخر");
    await handleMessage(a, m2, m2.text!);
    expect(lastText(a)).toBe(pick(CLIENT_WRITE_REFUSALS, m2.message_id));
    expect(await recent(db, chat.id, 5)).toHaveLength(0);
  });

  test("admin write in a private chat is not recorded", async () => {
    const priv = { id: ADMIN.id, type: "private" as const, first_name: "Sina" };
    const a = app();
    const before = (await recent(db, priv.id, 5)).length;
    const m = msg(priv, ADMIN, "#خرید ۱۰ تتر ۲۶۶۰۰۰");
    await handleMessage(a, m, m.text!);
    expect(await recent(db, priv.id, 5)).toHaveLength(before);
    expect(lastText(a)).toContain("گروه");
  });

  test("gemini failure falls back: NL text gets BUSY_TEXT", async () => {
    const chat = freshGroup();
    const a = app(nlu(null));
    const m = msg(chat, ADMIN, "صد تا تتر خریدم");
    await handleMessage(a, m, m.text!);
    expect(lastText(a)).toBe(BUSY_TEXT);
    expect(await recent(db, chat.id, 5)).toHaveLength(0);
  });

  test("gemini failure falls back: deviated # trade still gets a card with an ordinary line", async () => {
    const chat = freshGroup();
    const a = app(nlu(null));
    const m = msg(chat, ADMIN, "#فروش ۱۰۰ تتر ۲۷۹۳۰۰");
    await handleMessage(a, m, m.text!);
    expect(a.nlu.inputs).toHaveLength(1);
    const [e] = await recent(db, chat.id, 5);
    expect(e.status).toBe("pending");
    expect(e.joke).toBe(pick(ORDINARY_LINES, m.message_id));
    expect(lastButtons(a)).toContain(`ok:${e.id}`);
  });

  test("bare mention gets a hint without calling Gemini", async () => {
    const chat = freshGroup();
    const a = app(nlu({ intent: "chitchat", reply: "x" }));
    await handleMessage(a, msg(chat, CLIENT, "@acc_bot"), "");
    expect(a.nlu.inputs).toHaveLength(0);
    expect(sent(a)).toHaveLength(1);
  });

  test("chitchat reply is escaped and gets the joke", async () => {
    const chat = freshGroup();
    const a = app(nlu({ intent: "chitchat", reply: "سلام <دوست>", joke: "ha & ha" }));
    const m = msg(chat, CLIENT, "سلام");
    await handleMessage(a, m, m.text!);
    expect(lastText(a)).toBe("سلام &lt;دوست&gt;\n\n<i>ha &amp; ha</i>");
    expect(sent(a)[0].params.reply_parameters).toEqual({ message_id: m.message_id });
  });
});

describe("queries", () => {
  test("client balance ignores client_hint", async () => {
    const chatA = freshGroup();
    const chatB = freshGroup();
    await upsertAccount(db, { chatId: chatA.id, title: "Alpha", type: "supergroup", at: FIXED_NOW });
    await upsertAccount(db, { chatId: chatB.id, title: "Beta", type: "supergroup", at: FIXED_NOW });
    await approved(chatA.id, trade({ amount: D(10) }));
    await approved(chatB.id, trade({ amount: D(777) }));

    const a = app(nlu({ intent: "query_balance", client_hint: "Beta" }));
    const m = msg(chatA, CLIENT, "حساب Beta چقدره؟");
    await handleMessage(a, m, m.text!);
    const ledger = await approvedLedger(db, chatA.id);
    const expected = renderBalance("Alpha", summarize(ledger.map((l) => l.trade)), openDeals(ledger));
    expect(lastText(a)).toBe(expected);
    expect(lastText(a)).not.toContain("Beta");
  });

  test("admin in group also gets this chat's balance", async () => {
    const chatA = freshGroup();
    await upsertAccount(db, { chatId: chatA.id, title: "Gamma", type: "supergroup", at: FIXED_NOW });
    const a = app(nlu({ intent: "query_balance", client_hint: "Other" }));
    const m = msg(chatA, ADMIN, "حساب");
    await handleMessage(a, m, m.text!);
    expect(lastText(a)).toContain("Gamma");
  });

  test("admin private balance by name", async () => {
    const chatA = freshGroup();
    const name = `Zeta${chatA.id}`;
    await upsertAccount(db, { chatId: chatA.id, title: name, type: "supergroup", at: FIXED_NOW });
    await approved(chatA.id, trade({ amount: D(42) }));
    const priv = { id: ADMIN.id, type: "private" as const, first_name: "Sina" };
    const a = app(nlu({ intent: "query_balance", client_hint: name }));
    const m = msg(priv, ADMIN, `بدهی ${name} چقدره؟`);
    await handleMessage(a, m, m.text!);
    const ledger = await approvedLedger(db, chatA.id);
    expect(lastText(a)).toBe(renderBalance(name, summarize(ledger.map((l) => l.trade)), openDeals(ledger)));
    expect(a.nlu.inputs[0].accountNames).toContain(name);
  });

  test("admin private balance with several matches lists names", async () => {
    const c1 = freshGroup();
    const c2 = freshGroup();
    const tag = `Eta${c1.id}`;
    await upsertAccount(db, { chatId: c1.id, title: `${tag} one`, type: "supergroup", at: FIXED_NOW });
    await upsertAccount(db, { chatId: c2.id, title: `${tag} two`, type: "supergroup", at: FIXED_NOW });
    const priv = { id: ADMIN.id, type: "private" as const, first_name: "Sina" };
    const a = app(nlu({ intent: "query_deals", client_hint: tag }, { intent: "query_balance", client_hint: "nobody-xyz" }));
    const m = msg(priv, ADMIN, "معاملات");
    await handleMessage(a, m, m.text!);
    expect(lastText(a)).toContain(`${tag} one`);
    expect(lastText(a)).toContain(`${tag} two`);
    const m2 = msg(priv, ADMIN, "حساب");
    await handleMessage(a, m2, m2.text!);
    expect(lastText(a)).toContain("پیدا نشد");
  });

  test("price query fetches nobitex once and quotes coins", async () => {
    let nobitexCalls = 0;
    const base = prices({ "api.kucoin.com": { code: "200000", data: { price: "100000" } } });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("nobitex")) nobitexCalls++;
      return base(input, init);
    }) as typeof fetch;
    const chat = freshGroup();
    const a = app(nlu({ intent: "query_price", coins: ["BTC", "USDT"] }), f);
    const m = msg(chat, CLIENT, "بیت کوین چنده؟");
    await handleMessage(a, m, m.text!);
    expect(nobitexCalls).toBe(1);
    expect(lastText(a)).toContain("BTC");
    expect(lastText(a)).toContain("۲۶۶٬۰۰۰");
  });
});

describe("deal actions", () => {
  test("settle creates linked batch", async () => {
    const chat = freshGroup();
    const deal = await approved(chat.id, trade());
    const a = app(nlu({ intent: "settle_deal", deal_code: deal.code }));
    const m = msg(chat, ADMIN, `تسویه ${deal.code}`);
    await handleMessage(a, m, m.text!);

    const created = (await recent(db, chat.id, 10)).filter((e) => e.id !== deal.id);
    expect(created).toHaveLength(2);
    const receive = created.find((e) => e.trade.side === "RECEIVE")!;
    const pay = created.find((e) => e.trade.side === "PAY")!;
    expect(receive.trade.asset).toBe("IRT");
    expect(receive.trade.amount.eq(266_000_000)).toBe(true);
    expect(pay.trade.asset).toBe("USDT");
    expect(pay.trade.amount.eq(1000)).toBe(true);
    for (const e of created) {
      expect(e.status).toBe("pending");
      expect(e.linkedDealId).toBe(deal.id);
      expect(e.batchId).toBe(String(Math.min(receive.id, pay.id)));
    }
    expect(lastButtons(a)).toContain(`ok:${Math.min(receive.id, pay.id)}`);
    expect(lastText(a)).toContain("تسویه");
  });

  test("settle already-settled deal replies not open", async () => {
    const chat = freshGroup();
    const deal = await approved(chat.id, trade());
    await approved(chat.id, trade({ side: "RECEIVE", asset: "IRT", amount: D(266_000_000), rate: null }), deal.id);
    await approved(chat.id, trade({ side: "PAY", amount: D(1000), rate: null }), deal.id);
    const a = app(nlu({ intent: "settle_deal", deal_code: deal.code }));
    const m = msg(chat, ADMIN, "تسویه");
    await handleMessage(a, m, m.text!);
    expect(await recent(db, chat.id, 10)).toHaveLength(3);
    expect(lastText(a)).toContain(deal.code);
    expect(lastText(a)).toContain("باز نیست");
  });

  test("settle of an unknown deal says not found", async () => {
    const chat = freshGroup();
    const a = app(nlu({ intent: "settle_deal", deal_code: "D-<99999>" }));
    const m = msg(chat, ADMIN, "تسویه");
    await handleMessage(a, m, m.text!);
    expect(lastText(a)).toContain("پیدا نشد");
    expect(lastText(a)).toContain("D-&lt;99999&gt;");
  });

  test("reply to card resolves deal for cancel", async () => {
    const chat = freshGroup();
    const a = app(nlu({ intent: "cancel_deal" }));
    const m1 = msg(chat, ADMIN, "#خرید ۱۰۰۰ تتر ۲۶۶۰۰۰");
    await handleMessage(a, m1, m1.text!);
    const [e] = await recent(db, chat.id, 1);
    await transition(db, [e.id], "pending", "approved", { decidedBy: "@sina", decidedAt: FIXED_NOW });

    const card = { message_id: e.cardMsgId!, date: 0, chat, from: BOT, text: "card" };
    const m2 = msg(chat, ADMIN, "لغوش کن", { reply_to_message: card });
    await handleMessage(a, m2, m2.text!);
    expect(a.nlu.inputs[0].repliedText).toBe("card");
    expect(lastButtons(a)).toEqual([`cy:${e.id}`, `cn:${e.id}`]);
    expect(lastText(a)).toContain("مطمئن هستید");
    expect((await getEntry(db, e.id))!.status).toBe("approved");
  });

  test("cancel of a pending deal shows the pending keyboard", async () => {
    const chat = freshGroup();
    const e = await createEntry(db, {
      chatId: chat.id, trade: trade(), createdBy: "@sina", createdById: 1, createdAt: FIXED_NOW,
    });
    const a = app(nlu({ intent: "cancel_deal", deal_code: e.code }));
    const m = msg(chat, ADMIN, "لغو");
    await handleMessage(a, m, m.text!);
    expect(lastButtons(a)).toEqual([`ok:${e.id}`, `no:${e.id}`, `cx:${e.id}`]);
  });

  test("edit creates pending action, does not change entry", async () => {
    const chat = freshGroup();
    const deal = await approved(chat.id, trade({ side: "BUY", amount: D(100) }));
    const a = app(nlu({ intent: "edit_deal", deal_code: deal.code, changes: { rate_text: "۲۷۰" } }));
    const m = msg(chat, ADMIN, "قیمتش ۲۷۰ بود");
    await handleMessage(a, m, m.text!);

    const row = await db
      .prepare("SELECT * FROM pending_actions WHERE entry_id = ?")
      .bind(deal.id)
      .first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("edit");
    expect(row!.status).toBe("pending");
    const payload = JSON.parse(String(row!.payload_json));
    expect(payload).toMatchObject({ side: "BUY", amount: "100", asset: "USDT", rate: "270000", tomanTotal: null });
    expect(lastButtons(a)).toEqual([`ea:${row!.id}`, `ed:${row!.id}`]);
    const after = (await getEntry(db, deal.id))!;
    expect(after.trade.rate!.eq(266000)).toBe(true);
    expect(after.status).toBe("approved");
  });

  test("edit expands rate shorthand by the deal's own asset (R13)", async () => {
    const chat = freshGroup();
    const deal = await approved(chat.id, trade({ side: "BUY", amount: D(100), asset: "EUR", rate: D(290) }));
    const a = app(nlu({ intent: "edit_deal", deal_code: deal.code, changes: { rate_text: "۲۷۰" } }));
    const m = msg(chat, ADMIN, "قیمتش ۲۷۰ بود");
    await handleMessage(a, m, m.text!);
    const row = await db.prepare("SELECT payload_json FROM pending_actions WHERE entry_id = ?").bind(deal.id).first<{ payload_json: string }>();
    expect(JSON.parse(row!.payload_json).rate).toBe("270");
  });

  test("edit of a toman deal's rate recomputes the amount", async () => {
    const chat = freshGroup();
    const deal = await approved(
      chat.id,
      trade({ side: "BUY", amount: D("1893.94"), rate: D(264000), tomanTotal: D(500_000_000) }),
    );
    const a = app(nlu({ intent: "edit_deal", deal_code: deal.code, changes: { rate_text: "۲۵۰ هزار" } }));
    const m = msg(chat, ADMIN, "قیمت ۲۵۰ هزار");
    await handleMessage(a, m, m.text!);
    const row = await db.prepare("SELECT payload_json FROM pending_actions WHERE entry_id = ?").bind(deal.id).first<{ payload_json: string }>();
    expect(JSON.parse(row!.payload_json)).toMatchObject({ amount: "2000", rate: "250000", tomanTotal: "500000000" });
  });

  test("edit of a cancelled deal is refused", async () => {
    const chat = freshGroup();
    const deal = await approved(chat.id, trade());
    await transition(db, [deal.id], "approved", "cancelled");
    const a = app(nlu({ intent: "edit_deal", deal_code: deal.code, changes: { note: "x" } }));
    const m = msg(chat, ADMIN, "ویرایش");
    await handleMessage(a, m, m.text!);
    const row = await db.prepare("SELECT 1 FROM pending_actions WHERE entry_id = ?").bind(deal.id).first();
    expect(row).toBeNull();
    expect(lastButtons(a)).toEqual([]);
  });
});
