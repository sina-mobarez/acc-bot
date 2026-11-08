import type { CallbackQuery } from "@grammyjs/types";
import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import {
  approvedLedger, createEntry, createPendingAction, type Entry, getEntry, getPendingAction, type NewEntry, setBatch,
  setCardMessage, tradeToJson, transition,
} from "../src/db";
import { handleCallback, notifyChange } from "../src/handlers/callback";
import { allocate } from "../src/ledger";
import { TgError } from "../src/telegram";
import type { Trade } from "../src/trade";
import { makeApp, type TestApp } from "./fakes";

const db = env.DB;
const D = (s: string | number) => new Decimal(s);
const AT = "2026-11-08T10:00:00+03:30";
let nextChat = 5000;
const freshChat = () => -(++nextChat * 11);

const deal = (over: Partial<Trade> = {}): Trade => ({
  side: "BUY", amount: D(100), asset: "USDT", rate: D(275000), note: "", tomanTotal: null, ...over,
});
const pay = (over: Partial<Trade> = {}): Trade => ({
  side: "RECEIVE", amount: D(100), asset: "USDT", rate: null, note: "", tomanTotal: null, ...over,
});
const mk = (chatId: number, t: Trade, over: Partial<NewEntry> = {}) =>
  createEntry(db, { chatId, trade: t, createdBy: "ali", createdById: 5, createdAt: AT, ...over });
const approve = (e: Entry) => transition(db, [e.id], "pending", "approved");

const cb = (chatId: number, data: string, userId = 1, msgId = 50): CallbackQuery =>
  ({
    id: "q1",
    from: { id: userId, is_bot: false, first_name: "Admin" },
    chat_instance: "x",
    data,
    message: { message_id: msgId, chat: { id: chatId, type: "supergroup", title: "g" }, date: 0 },
  }) as unknown as CallbackQuery;

const calls = (app: TestApp, method: string) => app.tg.calls.filter((c) => c.method === method).map((c) => c.params);
const lastAnswer = (app: TestApp) => calls(app, "answerCallbackQuery").at(-1)!;

/** An approved deal plus a pending settlement batch of one payment for its full remaining amount. */
async function settlementFixture(chat: number) {
  const d = await mk(chat, deal({ rate: null }));
  await approve(d);
  const p = await mk(chat, pay({ note: `تسویه ${d.code}` }), { linkedDealId: d.id });
  await setBatch(db, [p.id], String(p.id));
  return { d, p };
}

describe("approve / reject", () => {
  test("approve moves pending to approved and edits card", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    const app = makeApp();
    await handleCallback(app, cb(chat, `ok:${e.id}`));
    expect((await getEntry(db, e.id))!.status).toBe("approved");
    const edits = calls(app, "editMessageText");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ chat_id: chat, message_id: 50 });
    expect(edits[0].text).toContain("تایید شد");
    expect(JSON.stringify(edits[0].reply_markup)).toContain(`cx:${e.id}`);
  });

  test("reject moves pending to rejected", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    await handleCallback(makeApp(), cb(chat, `no:${e.id}`));
    expect((await getEntry(db, e.id))!.status).toBe("rejected");
  });

  test("second approve is a no-op", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    const app = makeApp();
    await handleCallback(app, cb(chat, `ok:${e.id}`));
    await handleCallback(app, cb(chat, `ok:${e.id}`));
    expect(calls(app, "editMessageText")).toHaveLength(1);
    expect(lastAnswer(app).text).toContain("قبلاً");
  });

  test("non-admin cannot approve", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    const app = makeApp();
    await handleCallback(app, cb(chat, `ok:${e.id}`, 999));
    expect((await getEntry(db, e.id))!.status).toBe("pending");
    expect(lastAnswer(app)).toMatchObject({ text: "شما اجازه این کار را ندارید.", show_alert: true });
    expect(calls(app, "editMessageText")).toHaveLength(0);
  });

  test("an entry from another chat is not touched", async () => {
    const e = await mk(freshChat(), deal());
    await handleCallback(makeApp(), cb(freshChat(), `ok:${e.id}`));
    expect((await getEntry(db, e.id))!.status).toBe("pending");
  });

  test("a not-modified edit error is swallowed", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    const app = makeApp();
    app.tg.reply("editMessageText", () => {
      throw new TgError(400, "Bad Request: message is not modified");
    });
    await handleCallback(app, cb(chat, `ok:${e.id}`));
    expect((await getEntry(db, e.id))!.status).toBe("approved");
  });
});

describe("settlement batch", () => {
  test("approving settlement approves whole batch", async () => {
    const chat = freshChat();
    const d = await mk(chat, deal({ rate: null }));
    await approve(d);
    const p1 = await mk(chat, pay({ amount: D(60) }), { linkedDealId: d.id });
    const p2 = await mk(chat, pay({ amount: D(40) }), { linkedDealId: d.id });
    await setBatch(db, [p1.id, p2.id], String(p1.id));
    const app = makeApp();
    await handleCallback(app, cb(chat, `ok:${p1.id}`));
    expect((await getEntry(db, p1.id))!.status).toBe("approved");
    expect((await getEntry(db, p2.id))!.status).toBe("approved");
    const remaining = allocate(await approvedLedger(db, chat)).get(d.id)![0].remaining;
    expect(remaining.isZero()).toBe(true);
    const edit = calls(app, "editMessageText")[0];
    expect(edit.text).toContain("تایید شد");
    expect(JSON.stringify(edit.reply_markup)).not.toContain("ok:");
  });

  test("rejecting a settlement rejects the whole batch", async () => {
    const chat = freshChat();
    const { p } = await settlementFixture(chat);
    await handleCallback(makeApp(), cb(chat, `no:${p.id}`));
    expect((await getEntry(db, p.id))!.status).toBe("rejected");
  });

  test("second settlement batch for the same deal is refused and rejected, not over-settled", async () => {
    const chat = freshChat();
    const { d, p: first } = await settlementFixture(chat);
    const second = await mk(chat, pay({ note: "again" }), { linkedDealId: d.id });
    await setBatch(db, [second.id], String(second.id));
    const app = makeApp();

    await handleCallback(app, cb(chat, `ok:${first.id}`));
    expect((await getEntry(db, first.id))!.status).toBe("approved");

    await handleCallback(app, cb(chat, `ok:${second.id}`, 1, 51));
    expect((await getEntry(db, second.id))!.status).toBe("rejected");
    expect(lastAnswer(app)).toMatchObject({ show_alert: true });
    expect(String(lastAnswer(app).text)).toContain("تسویه");
    const leg = allocate(await approvedLedger(db, chat)).get(d.id)![0];
    expect(leg.remaining.isZero()).toBe(true);
  });
});

describe("settlement batch sums", () => {
  test("a batch of 60 + 60 against 100 remaining is refused and rejected", async () => {
    const chat = freshChat();
    const d = await mk(chat, deal({ rate: null }));
    await approve(d);
    const p1 = await mk(chat, pay({ amount: D(60) }), { linkedDealId: d.id });
    const p2 = await mk(chat, pay({ amount: D(60) }), { linkedDealId: d.id });
    await setBatch(db, [p1.id, p2.id], String(p1.id));
    const app = makeApp();
    await handleCallback(app, cb(chat, `ok:${p1.id}`));
    expect((await getEntry(db, p1.id))!.status).toBe("rejected");
    expect((await getEntry(db, p2.id))!.status).toBe("rejected");
    expect((await approvedLedger(db, chat)).length).toBe(1);
  });

  test("an unlinked member does not disable the check for linked ones", async () => {
    const chat = freshChat();
    const d = await mk(chat, deal({ rate: null }));
    await approve(d);
    const linked = await mk(chat, pay({ amount: D(150) }), { linkedDealId: d.id });
    const loose = await mk(chat, pay({ amount: D(1) }));
    await setBatch(db, [linked.id, loose.id], String(linked.id));
    await handleCallback(makeApp(), cb(chat, `ok:${linked.id}`));
    expect((await getEntry(db, linked.id))!.status).toBe("rejected");
    expect((await getEntry(db, loose.id))!.status).toBe("rejected");
  });
});

describe("cancel", () => {
  test("cancel pending cancels directly", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    await handleCallback(makeApp(), cb(chat, `cx:${e.id}`));
    expect((await getEntry(db, e.id))!.status).toBe("cancelled");
  });

  test("cancel approved needs confirm", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    await approve(e);
    const app = makeApp();
    await handleCallback(app, cb(chat, `cx:${e.id}`));
    expect((await getEntry(db, e.id))!.status).toBe("approved");
    expect(JSON.stringify(calls(app, "editMessageText")[0].reply_markup)).toContain(`cy:${e.id}`);

    await handleCallback(app, cb(chat, `cy:${e.id}`));
    expect((await getEntry(db, e.id))!.status).toBe("cancelled");
    const { results } = await db.prepare("SELECT action FROM entry_events WHERE entry_id = ?").bind(e.id).all();
    expect(results.map((r) => r.action)).toEqual(["cancel"]);
    expect(String(calls(app, "editMessageText").at(-1)!.text)).toContain("مانده حساب");
  });

  test("cn restores the normal keyboard", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    await approve(e);
    const app = makeApp();
    await handleCallback(app, cb(chat, `cn:${e.id}`));
    expect(JSON.stringify(calls(app, "editMessageText")[0].reply_markup)).toContain(`cx:${e.id}`);
  });

  test("cancel deal with linked payment keeps payment unlinked", async () => {
    const chat = freshChat();
    const d = await mk(chat, deal());
    await approve(d);
    const p = await mk(chat, pay({ amount: D(30) }), { linkedDealId: d.id });
    await approve(p);
    const app = makeApp();
    await handleCallback(app, cb(chat, `cy:${d.id}`));
    const kept = (await getEntry(db, p.id))!;
    expect(kept.status).toBe("approved");
    expect(kept.linkedDealId).toBeNull();
    expect(String(calls(app, "editMessageText")[0].text)).toContain("پرداخت‌های مرتبط باقی ماندند و به حساب کلی برگشتند");
  });
});

describe("edit proposals", () => {
  const proposal = (e: Entry, next: Trade) =>
    createPendingAction(db, {
      chatId: e.chatId, kind: "edit", entryId: e.id, payload: JSON.parse(tradeToJson(next)), createdBy: 1, createdAt: AT,
    });

  test("apply edit changes entry and records event", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    await approve(e);
    await setCardMessage(db, e.id, 77);
    const id = await proposal(e, deal({ amount: D(250) }));
    const app = makeApp();
    await handleCallback(app, cb(chat, `ea:${id}`, 1, 60));
    expect((await getEntry(db, e.id))!.trade.amount.toString()).toBe("250");
    const { results } = await db.prepare("SELECT action FROM entry_events WHERE entry_id = ?").bind(e.id).all();
    expect(results.map((r) => r.action)).toEqual(["edit"]);
    const edits = calls(app, "editMessageText");
    expect(edits.map((x) => x.message_id)).toEqual([60, 77]);
    expect(String(edits[1].text)).toContain("۲۵۰");
  });

  test("apply edit twice is a no-op", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    const id = await proposal(e, deal({ amount: D(250) }));
    const app = makeApp();
    await handleCallback(app, cb(chat, `ea:${id}`));
    const edits = calls(app, "editMessageText").length;
    await handleCallback(app, cb(chat, `ea:${id}`));
    expect(calls(app, "editMessageText")).toHaveLength(edits);
    expect(lastAnswer(app).text).toContain("قبلاً");
    const { results } = await db.prepare("SELECT 1 FROM entry_events WHERE entry_id = ?").bind(e.id).all();
    expect(results).toHaveLength(1);
  });

  test("apply edit to a cancelled entry is refused", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    await transition(db, [e.id], "pending", "cancelled");
    const id = await proposal(e, deal({ amount: D(250) }));
    await handleCallback(makeApp(), cb(chat, `ea:${id}`));
    expect((await getEntry(db, e.id))!.trade.amount.toString()).toBe("100");
    expect((await getPendingAction(db, id))!.status).toBe("discarded");
  });

  test("apply edit from another chat is refused and the action stays pending", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    const id = await proposal(e, deal({ amount: D(250) }));
    const app = makeApp();
    await handleCallback(app, cb(freshChat(), `ea:${id}`));
    expect((await getEntry(db, e.id))!.trade.amount.toString()).toBe("100");
    expect((await getPendingAction(db, id))!.status).toBe("pending");
    expect(lastAnswer(app)).toMatchObject({ show_alert: true });
    await handleCallback(app, cb(freshChat(), `ed:${id}`));
    expect((await getPendingAction(db, id))!.status).toBe("pending");
  });

  test("discard edit leaves the entry alone", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    const id = await proposal(e, deal({ amount: D(250) }));
    const app = makeApp();
    await handleCallback(app, cb(chat, `ed:${id}`));
    await handleCallback(app, cb(chat, `ea:${id}`));
    expect((await getEntry(db, e.id))!.trade.amount.toString()).toBe("100");
  });
});

describe("notifyChange", () => {
  test("replies to the card in the entry's chat", async () => {
    const chat = freshChat();
    const e = await mk(chat, deal());
    await setCardMessage(db, e.id, 88);
    const app = makeApp();
    await notifyChange(app, (await getEntry(db, e.id))!, "hello");
    expect(calls(app, "sendMessage")[0]).toMatchObject({
      chat_id: chat, text: "hello", reply_parameters: { message_id: 88 },
    });
  });
});
