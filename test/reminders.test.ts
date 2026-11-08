import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, test } from "vitest";
import { runCron } from "../src/cron";
import { createBroadcast, createEntry, getAccount, markUpdateSeen, transition, updateAccount, upsertAccount } from "../src/db";
import { runReminders } from "../src/reminders";
import { TgError } from "../src/telegram";
import type { Side } from "../src/trade";
import { INVOCATION_BUDGET } from "../src/constants";
import { makeApp } from "./fakes";

const db = env.DB;
const AT = "2026-11-08T10:00:00+03:30";
const NOON = new Date("2026-11-08T09:00:00Z"); // 12:30 Tehran
const EARLY = new Date("2026-11-08T06:29:00Z"); // 09:59 Tehran

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM entries"), db.prepare("DELETE FROM accounts")]);
});

async function account(chatId: number, title = "گروه") {
  await upsertAccount(db, { chatId, title, type: "supergroup", at: AT, activated: true });
}

async function deal(chatId: number, side: Side, amount: number, rate: number | null, asset = "USDT") {
  const e = await createEntry(db, {
    chatId, createdBy: "ali", createdById: 5, createdAt: AT,
    trade: {
      side, amount: new Decimal(amount), asset,
      rate: rate === null ? null : new Decimal(rate), note: "", tomanTotal: null,
    },
  });
  await transition(db, [e.id], "pending", "approved");
}

const debtor = async (chatId: number) => {
  await account(chatId);
  await deal(chatId, "BUY", 100, 275000);
};

const sent = (app: ReturnType<typeof makeApp>) =>
  app.tg.calls.filter((c) => c.method === "sendMessage").map((c) => c.params);

describe("runReminders", () => {
  test("before 10:00 Tehran sends nothing", async () => {
    await debtor(-1001);
    const app = makeApp();
    expect(await runReminders(app, EARLY)).toEqual({ sent: 0, remaining: 0 });
    expect(sent(app)).toHaveLength(0);
  });

  test("sends only to debtors", async () => {
    await debtor(-1001); // client owes us
    await account(-1002); // we owe them (unpriced sell)
    await deal(-1002, "SELL", 50, null);
    await account(-1003); // settled
    await deal(-1003, "BUY", 100, null);
    await deal(-1003, "RECEIVE", 100, null);
    const app = makeApp();
    const r = await runReminders(app, NOON);
    expect(r).toEqual({ sent: 1, remaining: 0 });
    expect(sent(app)).toHaveLength(1);
    expect(sent(app)[0].chat_id).toBe(-1001);
    expect(sent(app)[0].parse_mode).toBe("HTML");
  });

  test("shows both sides", async () => {
    await account(-1001);
    await deal(-1001, "BUY", 1000, 266000);
    const app = makeApp();
    await runReminders(app, NOON);
    const text = String(sent(app)[0].text);
    expect(text).toContain("بدهکارید");
    expect(text).toContain("بدهکاریم");
  });

  test("idempotent same day", async () => {
    await debtor(-1001);
    const app = makeApp();
    await runReminders(app, NOON);
    expect(await runReminders(app, NOON)).toEqual({ sent: 0, remaining: 0 });
    expect(sent(app)).toHaveLength(1);
    expect((await getAccount(db, -1001))?.remindedOn).toBe("2026-11-08");
  });

  test("batches", async () => {
    for (let i = 1; i <= 45; i++) await debtor(-2000 - i);
    const app = makeApp();
    expect(await runReminders(app, NOON)).toEqual({ sent: 40, remaining: 5 });
    expect(await runReminders(app, NOON)).toEqual({ sent: 5, remaining: 0 });
    expect(sent(app)).toHaveLength(45);
  });

  test("403 marks left and continues", async () => {
    await debtor(-1001);
    await debtor(-1002);
    const app = makeApp();
    app.tg.fail("sendMessage", -1002, new TgError(403, "Forbidden: bot was kicked"));
    const r = await runReminders(app, NOON);
    expect(r.sent).toBe(1);
    expect((await getAccount(db, -1002))?.botStatus).toBe("left");
    expect(sent(app).map((p) => p.chat_id)).toEqual([-1002, -1001]);
  });

  test("retry_after stops the batch and leaves the rest for next run", async () => {
    await debtor(-1001);
    await debtor(-1002);
    const app = makeApp();
    app.tg.fail("sendMessage", -1002, new TgError(429, "Too Many Requests", { retry_after: 5 }));
    expect(await runReminders(app, NOON)).toEqual({ sent: 0, remaining: 2 });
    expect((await getAccount(db, -1002))?.remindedOn).toBeNull();
  });

  test("supergroup migration retries once on the new chat", async () => {
    await debtor(-1001);
    const app = makeApp();
    app.tg.fail("sendMessage", -1001, new TgError(400, "migrated", { migrate_to_chat_id: -100999 }));
    expect((await runReminders(app, NOON)).sent).toBe(1);
    expect(sent(app).map((p) => p.chat_id)).toEqual([-1001, -100999]);
    expect((await getAccount(db, -100999))?.remindedOn).toBe("2026-11-08");
  });

  test("reminders_off, archived and non-activated accounts are skipped", async () => {
    await debtor(-1001);
    await debtor(-1002);
    await debtor(-1003);
    await debtor(-1004);
    await updateAccount(db, -1002, { remindersOn: false });
    await updateAccount(db, -1003, { archived: true });
    await db.prepare("UPDATE accounts SET activated = 0 WHERE chat_id = -1004").run();
    const app = makeApp();
    await runReminders(app, NOON);
    expect(sent(app).map((p) => p.chat_id)).toEqual([-1001]);
  });
});

describe("runCron", () => {
  test("runs reminders and prunes old processed updates", async () => {
    await debtor(-1001);
    await markUpdateSeen(db, 1, "2026-11-01T10:00:00+03:30");
    await markUpdateSeen(db, 2, "2026-11-08T10:00:00+03:30");
    const app = makeApp();
    await runCron(app, NOON);
    expect(sent(app)).toHaveLength(1);
    expect(await markUpdateSeen(db, 1, AT)).toBe(true); // was pruned
    expect(await markUpdateSeen(db, 2, AT)).toBe(false); // kept
  });

  test("reminders plus a broadcast share one budget per tick and finish over later ticks", async () => {
    await db.batch([db.prepare("DELETE FROM broadcasts"), db.prepare("DELETE FROM broadcast_messages")]);
    for (let i = 0; i < 60; i++) await debtor(-2000 - i);
    await createBroadcast(db, {
      fromChatId: 5, fromMessageId: 9, preview: "x", createdBy: "a", createdById: 1, createdAt: AT,
      statusChatId: 5, statusMsgId: 1,
    });

    // Count D1 statements (every statement in a batch counts) next to the Telegram calls.
    let d1 = 0;
    const wrap = (raw: any): any => ({
      raw,
      bind: (...a: unknown[]) => wrap(raw.bind(...a)),
      run: () => (d1++, raw.run()),
      all: () => (d1++, raw.all()),
      first: () => (d1++, raw.first()),
    });
    const counted = {
      prepare: (q: string) => wrap(db.prepare(q)),
      batch: (st: any[]) => ((d1 += st.length), db.batch(st.map((x) => x.raw))),
    } as unknown as D1Database;
    const app = makeApp({ db: counted });

    for (let tick = 0; tick < 6; tick++) {
      d1 = 0;
      const before = app.tg.calls.length;
      await runCron(app, NOON);
      expect(app.tg.calls.length - before + d1).toBeLessThanOrEqual(INVOCATION_BUDGET);
    }
    expect(app.tg.calls.filter((c) => c.method === "sendMessage")).toHaveLength(60);
    expect(app.tg.calls.filter((c) => c.method === "copyMessage")).toHaveLength(60);
  });
});
