import type { CallbackQuery, Message } from "@grammyjs/types";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import {
  handleBroadcastCallback, onBroadcastCapture, onBroadcastCommand, onCancelCommand, onGroupsCommand,
  runBroadcastBatch,
} from "../src/broadcast";
import { BATCH_SIZE } from "../src/constants";
import { addAdmin, getAccount, getUserState, upsertAccount } from "../src/db";
import { handleCallback } from "../src/handlers/callback";
import { TgError } from "../src/telegram";
import { makeApp } from "./fakes";

const db = env.DB;
const AT = "2026-11-08T10:00:00+03:30";
const ADMIN = 1;
const DM = 555;

const msg = (text: string, userId = ADMIN, extra: Record<string, unknown> = {}): Message =>
  ({
    message_id: 70, date: 0, text,
    chat: { id: DM, type: "private" },
    from: { id: userId, is_bot: false, first_name: "A" },
    ...extra,
  }) as unknown as Message;

const cb = (data: string, userId = ADMIN): CallbackQuery =>
  ({
    id: "q1", chat_instance: "x", data,
    from: { id: userId, is_bot: false, first_name: "A" },
    message: { message_id: 90, date: 0, chat: { id: DM, type: "private" } },
  }) as unknown as CallbackQuery;

async function groups(n: number, status = "member"): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const chatId = -1000 - ids.length - (status === "member" ? 0 : 500);
    await upsertAccount(db, { chatId, title: `گروه ${chatId}`, type: "supergroup", at: AT, botStatus: status });
    ids.push(chatId);
  }
  return ids;
}

const calls = (app: ReturnType<typeof makeApp>, method: string) =>
  app.tg.calls.filter((c) => c.method === method).map((c) => c.params);

/** Admin walks through /broadcast -> message -> bc:go. */
async function startBroadcast(app: ReturnType<typeof makeApp>) {
  await onBroadcastCommand(app, msg("/broadcast"));
  await onBroadcastCapture(app, msg("سلام به همه"));
  await handleBroadcastCallback(app, cb("bc:go"));
  await app.flush();
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM accounts"),
    db.prepare("DELETE FROM broadcasts"),
    db.prepare("DELETE FROM broadcast_messages"),
    db.prepare("DELETE FROM user_state"),
    db.prepare("DELETE FROM admins"),
  ]);
});

describe("broadcast", () => {
  test("deny when no admins", async () => {
    const app = makeApp({ adminIds: new Set() });
    await onBroadcastCommand(app, msg("/broadcast", 42));
    const text = String(calls(app, "sendMessage")[0].text);
    expect(text).toContain("هنوز فعال نشده");
    expect(text).toContain("<code>42</code>");
    expect(await getUserState(db, 42)).toBeNull();
    await onGroupsCommand(app, msg("/groups", 42));
    expect(String(calls(app, "sendMessage")[1].text)).toContain("هنوز فعال نشده");
  });

  test("deny non-admin when admins exist; admins table counts", async () => {
    const app = makeApp({ adminIds: new Set() });
    await addAdmin(db, 7, "x", null, AT);
    await onBroadcastCommand(app, msg("/broadcast", 42));
    expect(String(calls(app, "sendMessage")[0].text)).toContain("اجازه ارسال همگانی ندارید");
    await onBroadcastCommand(app, msg("/broadcast", 7));
    expect((await getUserState(db, 7))?.state).toBe("broadcast_waiting");
  });

  test("full flow queues and sends", async () => {
    await groups(3);
    const app = makeApp();
    await onBroadcastCommand(app, msg("/broadcast"));
    expect((await getUserState(db, ADMIN))?.state).toBe("broadcast_waiting");
    await onBroadcastCapture(app, msg("سلام به همه"));
    expect((await getUserState(db, ADMIN))?.state).toBe("broadcast_confirm");
    const confirm = calls(app, "sendMessage")[1];
    expect(String(confirm.text)).toContain("۳ گروه");

    await handleBroadcastCallback(app, cb("bc:go"));
    expect(calls(app, "editMessageText")[0].text).toBe("⏳ در حال ارسال…");
    await app.flush();

    const copies = calls(app, "copyMessage");
    expect(copies).toHaveLength(3);
    expect(copies[0]).toMatchObject({ from_chat_id: DM, message_id: 70 });
    const final = calls(app, "editMessageText").at(-1)!;
    expect(String(final.text)).toContain("ارسال شد: ۳ از ۳");
    expect(JSON.stringify(final.reply_markup)).toContain("bd:");
    expect(await getUserState(db, ADMIN)).toBeNull();
  });

  test("bc:no cancels and a second bc:go is expired", async () => {
    await groups(1);
    const app = makeApp();
    await onBroadcastCommand(app, msg("/broadcast"));
    await onBroadcastCapture(app, msg("x"));
    await handleBroadcastCallback(app, cb("bc:no"));
    expect(calls(app, "editMessageText")[0].text).toContain("لغو شد");
    await handleBroadcastCallback(app, cb("bc:go"));
    expect(calls(app, "answerCallbackQuery").at(-1)).toMatchObject({ show_alert: true });
    expect(calls(app, "copyMessage")).toHaveLength(0);
  });

  test("/cancel clears a pending broadcast", async () => {
    const app = makeApp();
    await onBroadcastCommand(app, msg("/broadcast"));
    await onCancelCommand(app, msg("/cancel"));
    expect(await getUserState(db, ADMIN)).toBeNull();
    expect(calls(app, "sendMessage").at(-1)!.text).toBe("لغو شد.");
    await onCancelCommand(app, msg("/cancel"));
    expect(calls(app, "sendMessage").at(-1)!.text).toBe("کاری برای لغو وجود ندارد.");
  });

  test("failed delivery recorded, batch continues", async () => {
    const [, b] = await groups(3);
    const app = makeApp();
    app.tg.fail("copyMessage", b, new TgError(400, "Bad Request: have no rights to send a message"));
    await startBroadcast(app);
    expect(calls(app, "copyMessage")).toHaveLength(3);
    const final = String(calls(app, "editMessageText").at(-1)!.text);
    expect(final).toContain("ارسال شد: ۲ از ۳");
    expect(final).toContain("ناموفق: ۱");
    expect(final).toContain("have no rights");
  });

  test("forbidden marks the account left", async () => {
    const [a] = await groups(2);
    const app = makeApp();
    app.tg.fail("copyMessage", a, new TgError(403, "Forbidden: bot was kicked"));
    await startBroadcast(app);
    expect((await getAccount(db, a))?.botStatus).toBe("left");
    expect(String(calls(app, "editMessageText").at(-1)!.text)).toContain("ارسال شد: ۱ از ۲");
  });

  test("migrated chat retried at new id", async () => {
    const [a] = await groups(1);
    const NEW = -100999;
    const app = makeApp();
    app.tg.fail("copyMessage", a, new TgError(400, "Bad Request: group chat was upgraded", { migrate_to_chat_id: NEW }));
    await startBroadcast(app);
    const copies = calls(app, "copyMessage");
    expect(copies.map((c) => c.chat_id)).toEqual([a, NEW]);
    expect((await getAccount(db, NEW))?.botStatus).toBe("member");
    expect(String(calls(app, "editMessageText").at(-1)!.text)).toContain("ارسال شد: ۱ از ۱");
  });

  test("kicked/left/archived groups excluded", async () => {
    const [active] = await groups(1);
    await groups(1, "kicked");
    await upsertAccount(db, { chatId: -3, title: "L", type: "group", at: AT, botStatus: "left" });
    await upsertAccount(db, { chatId: -4, title: "A", type: "group", at: AT });
    await db.prepare("UPDATE accounts SET archived = 1 WHERE chat_id = -4").run();
    const app = makeApp();
    await startBroadcast(app);
    expect(calls(app, "copyMessage").map((c) => c.chat_id)).toEqual([active]);
  });

  test("rate limit stops the batch; the rest continues next run", async () => {
    await groups(3);
    const app = makeApp();
    let n = 0;
    app.tg.reply("copyMessage", () => {
      if (++n === 2) throw new TgError(429, "Too Many Requests", { retry_after: 3 });
      return { message_id: 500 + n };
    });
    await startBroadcast(app);
    expect(calls(app, "copyMessage")).toHaveLength(2);
    expect(calls(app, "editMessageText")).toHaveLength(1); // only "sending", not the report
    await runBroadcastBatch(app);
    expect(calls(app, "copyMessage")).toHaveLength(4);
    expect(String(calls(app, "editMessageText").at(-1)!.text)).toContain("ارسال شد: ۳ از ۳");
  });

  test("a batch never makes more than BATCH_SIZE Telegram calls", async () => {
    await groups(BATCH_SIZE + 10);
    const app = makeApp();
    await startBroadcast(app);
    const first = app.tg.calls.filter((c) => c.method === "copyMessage" || c.method === "deleteMessage");
    expect(first.length).toBeLessThanOrEqual(BATCH_SIZE);
    expect(calls(app, "copyMessage").length).toBe(BATCH_SIZE - 1);
    await runBroadcastBatch(app);
    expect(calls(app, "copyMessage")).toHaveLength(BATCH_SIZE + 10);
    expect(String(calls(app, "editMessageText").at(-1)!.text)).toContain(`ارسال شد: ۵۰ از ۵۰`);
  });

  test("delete-all queues and deletes sent rows", async () => {
    const [a, b, c] = await groups(3);
    const app = makeApp();
    let n = 100;
    app.tg.reply("copyMessage", () => ({ message_id: ++n }));
    app.tg.fail("copyMessage", c, new TgError(400, "nope"));
    await startBroadcast(app);
    const id = (await db.prepare("SELECT id FROM broadcasts").first<{ id: number }>())!.id;

    await handleBroadcastCallback(app, cb(`bd:${id}`));
    expect(JSON.stringify(calls(app, "editMessageReplyMarkup").at(-1)!.reply_markup)).toContain(`bdy:${id}`);
    await handleBroadcastCallback(app, cb(`bdn:${id}`));
    expect(JSON.stringify(calls(app, "editMessageReplyMarkup").at(-1)!.reply_markup)).toContain(`bd:${id}`);

    app.tg.reply("deleteMessage", (p) => {
      if (p.chat_id === b) throw new TgError(400, "message can't be deleted");
      return true;
    });
    await handleCallback(app, cb(`bdy:${id}`)); // routed through the main callback handler
    await app.flush();
    const dels = calls(app, "deleteMessage");
    expect(dels.map((d) => d.chat_id).sort()).toEqual([a, b].sort());
    const final = String(calls(app, "editMessageText").at(-1)!.text);
    expect(final).toContain("حذف شد از ۱ گروه");
    expect(final).toContain("ناموفق: ۱");
    expect((await db.prepare("SELECT status FROM broadcasts").first<{ status: string }>())!.status).toBe("deleted");

    // second tap: already deleted
    await handleBroadcastCallback(app, cb(`bdy:${id}`));
    expect(calls(app, "answerCallbackQuery").at(-1)!.text).toBe("این پیام قبلاً حذف شده است.");
    expect(calls(app, "deleteMessage")).toHaveLength(2);
  });

  test("non-admin cannot press broadcast buttons", async () => {
    const app = makeApp();
    await handleBroadcastCallback(app, cb("bc:go", 42));
    expect(calls(app, "answerCallbackQuery")[0]).toMatchObject({ show_alert: true });
    expect(calls(app, "copyMessage")).toHaveLength(0);
  });

  test("/groups lists active groups", async () => {
    await groups(2);
    const app = makeApp();
    await onGroupsCommand(app, msg("/groups"));
    const text = String(calls(app, "sendMessage")[0].text);
    expect(text).toContain("۲ گروه");
    expect(text).toContain("گروه -1000");
  });
});
