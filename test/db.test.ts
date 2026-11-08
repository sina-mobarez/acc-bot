import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import {
  addAdmin,
  allApprovedByChat,
  approvedLedger,
  cancelEntry,
  createEntry,
  createPendingAction,
  dealCode,
  editEntry,
  getAccount,
  getEntry,
  getSetting,
  isAdmin,
  listAccounts,
  listEntries,
  markUpdateSeen,
  migrateChat,
  type NewEntry,
  recent,
  setCardMessage,
  setSetting,
  takePendingAction,
  tradeToJson,
  transition,
  unlinkPayments,
  updateAccount,
  upsertAccount,
} from "../src/db";
import type { Trade } from "../src/trade";

const db = env.DB;
const D = (s: string | number) => new Decimal(s);
const AT = "2026-11-08T10:00:00+03:30";

let nextChat = 1000;
const freshChat = () => ++nextChat * 7;

const trade = (over: Partial<Trade> = {}): Trade => ({
  side: "BUY",
  amount: D(100),
  asset: "USDT",
  rate: D(275000),
  note: "",
  tomanTotal: null,
  ...over,
});

const mk = (chatId: number, t: Trade = trade(), over: Partial<NewEntry> = {}) =>
  createEntry(db, { chatId, trade: t, createdBy: "ali", createdById: 5, createdAt: AT, ...over });

describe("entries", () => {
  test("transition is exclusive", async () => {
    const e = await mk(freshChat());
    expect(await transition(db, [e.id], "pending", "approved", { decidedBy: "admin", decidedAt: AT })).toBe(true);
    expect(await transition(db, [e.id], "pending", "approved")).toBe(false);
    const got = (await getEntry(db, e.id))!;
    expect(got.status).toBe("approved");
    expect(got.decidedBy).toBe("admin");
    expect(got.code).toBe(dealCode(e.id));
  });

  test("batch transition is all-or-nothing", async () => {
    const chat = freshChat();
    const a = await mk(chat);
    const b = await mk(chat);
    expect(await transition(db, [b.id], "pending", "rejected")).toBe(true);
    expect(await transition(db, [a.id, b.id], "pending", "approved")).toBe(false);
    expect((await getEntry(db, a.id))!.status).toBe("pending");
    expect((await getEntry(db, b.id))!.status).toBe("rejected");
  });

  test("batch transition applies to every id when all match", async () => {
    const chat = freshChat();
    const a = await mk(chat);
    const b = await mk(chat);
    expect(await transition(db, [a.id, b.id, a.id], "pending", "approved")).toBe(true);
    expect((await getEntry(db, b.id))!.status).toBe("approved");
  });

  test("recent is per chat, newest first", async () => {
    const c1 = freshChat();
    const c2 = freshChat();
    const a = await mk(c1);
    await mk(c2);
    const b = await mk(c1);
    expect((await recent(db, c1, 10)).map((e) => e.id)).toEqual([b.id, a.id]);
    expect(await recent(db, c1, 1)).toHaveLength(1);
  });

  test("toman_total and decimals round-trip exactly", async () => {
    const e = await mk(freshChat(), trade({ amount: D("1893.94"), rate: D(264000), tomanTotal: D(500000000) }));
    const got = (await getEntry(db, e.id))!;
    expect(got.trade.amount.toFixed()).toBe("1893.94");
    expect(got.trade.tomanTotal!.toFixed()).toBe("500000000");
    expect(got.trade.rate!.toFixed()).toBe("264000");
  });

  test("toman_total without a rate is rejected", async () => {
    await expect(mk(freshChat(), trade({ rate: null, tomanTotal: D(5) }))).rejects.toThrow();
    const e = await mk(freshChat());
    await expect(editEntry(db, e.id, trade({ rate: null, tomanTotal: D(5) }), "x", AT)).rejects.toThrow();
  });

  test("editEntry records before/after event", async () => {
    const e = await mk(freshChat());
    const updated = await editEntry(db, e.id, trade({ amount: D(250), note: "fix" }), "admin", AT);
    expect(updated.trade.amount.toFixed()).toBe("250");
    expect(updated.trade.note).toBe("fix");
    const ev = await db
      .prepare("SELECT * FROM entry_events WHERE entry_id = ?")
      .bind(e.id)
      .first<Record<string, string>>();
    expect(ev!.action).toBe("edit");
    expect(ev!.actor).toBe("admin");
    expect(JSON.parse(ev!.before_json).amount).toBe("100");
    expect(JSON.parse(ev!.after_json).amount).toBe("250");
  });

  test("cancelEntry transitions and records an event once", async () => {
    const e = await mk(freshChat());
    await transition(db, [e.id], "pending", "approved");
    expect(await cancelEntry(db, e.id, "approved", "admin", AT)).toBe(true);
    expect(await cancelEntry(db, e.id, "approved", "admin", AT)).toBe(false);
    const evs = await db
      .prepare("SELECT * FROM entry_events WHERE entry_id = ?")
      .bind(e.id)
      .all<Record<string, string | null>>();
    expect(evs.results).toHaveLength(1);
    expect(evs.results[0].action).toBe("cancel");
    expect(JSON.parse(evs.results[0].before_json!)).toEqual(JSON.parse(tradeToJson(e.trade)));
    expect(evs.results[0].after_json).toBeNull();
    expect((await getEntry(db, e.id))!.cancelledBy).toBe("admin");
  });

  test("ledger queries return approved entries only, in id order", async () => {
    const chat = freshChat();
    const a = await mk(chat);
    const b = await mk(chat, trade({ side: "PAY", rate: null, asset: "IRT" }), { linkedDealId: a.id });
    await mk(chat); // stays pending
    await transition(db, [a.id, b.id], "pending", "approved");
    const ledger = await approvedLedger(db, chat);
    expect(ledger.map((l) => l.id)).toEqual([a.id, b.id]);
    expect(Object.keys(ledger[0]).sort()).toEqual(["id", "linkedDealId", "trade"]);
    expect(ledger[1].linkedDealId).toBe(a.id);
    expect((await allApprovedByChat(db)).get(chat)!.map((l) => l.id)).toEqual([a.id, b.id]);
  });

  test("listEntries filters and paginates", async () => {
    const chat = freshChat();
    const a = await mk(chat);
    const b = await mk(chat, trade({ side: "SELL" }));
    expect((await listEntries(db, { chatId: chat, kind: "SELL", limit: 10 })).map((e) => e.id)).toEqual([b.id]);
    expect((await listEntries(db, { chatId: chat, before: b.id, limit: 10 })).map((e) => e.id)).toEqual([a.id]);
  });
});

describe("accounts", () => {
  test("upsertAccount keeps admin status but revives left", async () => {
    const chat = freshChat();
    await upsertAccount(db, { chatId: chat, title: "G", type: "group", at: AT, botStatus: "administrator" });
    await upsertAccount(db, { chatId: chat, title: "G2", type: "supergroup", at: AT });
    let a = (await getAccount(db, chat))!;
    expect(a.botStatus).toBe("administrator");
    expect(a.title).toBe("G2");
    await updateAccount(db, chat, { botStatus: "left" });
    await upsertAccount(db, { chatId: chat, title: "G2", type: "supergroup", at: AT });
    a = (await getAccount(db, chat))!;
    expect(a.botStatus).toBe("member");
  });

  test("first insert without botStatus is member; listed only once activated", async () => {
    const chat = freshChat();
    expect(await upsertAccount(db, { chatId: chat, title: "New", type: "group", at: AT })).toEqual({ activated: false });
    expect((await getAccount(db, chat))!.botStatus).toBe("member");
    const listed = async () => (await listAccounts(db, { activeOnly: true })).some((a) => a.chatId === chat);
    expect(await listed()).toBe(false);
    expect(await upsertAccount(db, { chatId: chat, title: "New", type: "group", at: AT, activated: true })).toEqual({ activated: true });
    expect(await listed()).toBe(true);
    // Activation is sticky: later non-admin traffic or status updates never undo it.
    expect(await upsertAccount(db, { chatId: chat, title: "New", type: "group", at: AT })).toEqual({ activated: true });
    await upsertAccount(db, { chatId: chat, title: "New", type: "group", at: AT, botStatus: "administrator" });
    expect((await getAccount(db, chat))!.activated).toBe(true);
  });

  test("reminders_default setting seeds reminders_on for new accounts only", async () => {
    const existing = freshChat();
    await upsertAccount(db, { chatId: existing, title: "E", type: "group", at: AT });
    await setSetting(db, "reminders_default", "0");
    try {
      const fresh = freshChat();
      await upsertAccount(db, { chatId: fresh, title: "F", type: "group", at: AT });
      const viaStatus = freshChat();
      await upsertAccount(db, { chatId: viaStatus, title: "S", type: "group", at: AT, botStatus: "administrator" });
      await upsertAccount(db, { chatId: existing, title: "E2", type: "group", at: AT });
      expect((await getAccount(db, fresh))!.remindersOn).toBe(false);
      expect((await getAccount(db, viaStatus))!.remindersOn).toBe(false);
      expect((await getAccount(db, existing))!.remindersOn).toBe(true);
    } finally {
      await db.prepare("DELETE FROM settings WHERE key = 'reminders_default'").run();
    }
    const dflt = freshChat();
    await upsertAccount(db, { chatId: dflt, title: "D", type: "group", at: AT });
    expect((await getAccount(db, dflt))!.remindersOn).toBe(true);
  });

  test("migrateChat moves entries and account", async () => {
    const from = freshChat();
    const to = freshChat();
    await upsertAccount(db, { chatId: from, title: "Old", type: "group", at: AT });
    await updateAccount(db, from, { remindersOn: false });
    const e = await mk(from, trade(), { sourceMsgId: 41 });
    await setCardMessage(db, e.id, 42);
    await migrateChat(db, from, to);
    expect((await getEntry(db, e.id))!.chatId).toBe(to);
    // Supergroups restart message ids: the old card/source ids would point at someone else's messages.
    const ids = await db.prepare("SELECT card_msg_id, source_msg_id FROM entries WHERE id = ?").bind(e.id).first();
    expect(ids).toEqual({ card_msg_id: null, source_msg_id: null });
    expect(await getAccount(db, from)).toBeNull();
    const a = (await getAccount(db, to))!;
    expect(a.title).toBe("Old");
    expect(a.remindersOn).toBe(false);
  });
});

describe("admins and bookkeeping", () => {
  test("isAdmin", async () => {
    await addAdmin(db, 222, "Bob", 1, AT);
    expect(await isAdmin(db, new Set([111]), 111)).toBe(true);
    expect(await isAdmin(db, new Set([111]), 222)).toBe(true);
    expect(await isAdmin(db, new Set([111]), 333)).toBe(false);
  });

  test("markUpdateSeen true once", async () => {
    expect(await markUpdateSeen(db, 9001, AT)).toBe(true);
    expect(await markUpdateSeen(db, 9001, AT)).toBe(false);
  });

  test("settings upsert", async () => {
    expect(await getSetting(db, "deviation_pct")).toBeNull();
    await setSetting(db, "deviation_pct", "3");
    await setSetting(db, "deviation_pct", "5");
    expect(await getSetting(db, "deviation_pct")).toBe("5");
  });

  test("takePendingAction is compare-and-set", async () => {
    const id = await createPendingAction(db, {
      chatId: 1,
      kind: "edit",
      entryId: 1,
      payload: { a: 1 },
      createdBy: 5,
      createdAt: AT,
    });
    const got = await takePendingAction(db, id, "applied");
    expect(got!.payload).toEqual({ a: 1 });
    expect(await takePendingAction(db, id, "discarded")).toBeNull();
  });
});

describe("unlinkPayments", () => {
  test("detaches approved payments only", async () => {
    const chat = freshChat();
    const d = await mk(chat);
    const pay = trade({ side: "RECEIVE", rate: null });
    const approved = await mk(chat, pay, { linkedDealId: d.id, status: "approved" });
    const pending = await mk(chat, pay, { linkedDealId: d.id });
    expect(await unlinkPayments(db, d.id)).toBe(1);
    expect((await getEntry(db, approved.id))!.linkedDealId).toBeNull();
    expect((await getEntry(db, pending.id))!.linkedDealId).toBe(d.id);
  });
});
