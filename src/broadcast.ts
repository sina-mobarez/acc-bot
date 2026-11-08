import type { CallbackQuery, Message, User } from "@grammyjs/types";
import type { App } from "./app";
import { escapeHtml, type Keyboard } from "./cards";
import { BATCH_SIZE } from "./constants";
import {
  accountName, type Broadcast, broadcastReport, clearUserState, createBroadcast, drainedBroadcasts,
  getUserState, isAdmin, listAccounts, listAdmins, migrateChat, nextBroadcastWork, setBroadcastStatus,
  setDelivery, setUserState, startBroadcastDelete, takeUserState, updateAccount,
} from "./db";
import { fa } from "./money";
import { isForbidden, isNotModified, TgError } from "./telegram";

const WAITING = "broadcast_waiting";
const CONFIRM = "broadcast_confirm";

const NOT_ALLOWED = "شما اجازه این کار را ندارید.";
const FORBIDDEN_ERROR = "ربات از گروه حذف شده یا اجازه ارسال ندارد";

interface Source {
  fromChatId: number;
  fromMessageId: number;
  preview: string;
}

const who = (u: User): string =>
  u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ");

function preview(msg: Message): string {
  const m = msg as unknown as Record<string, unknown>;
  const text = msg.text ?? msg.caption ?? "";
  const kind = ["photo", "video", "document", "audio", "voice", "animation", "sticker"].find((k) => m[k]) ?? "";
  return ((kind ? `[${kind}] ` : "") + text).slice(0, 200) || "[پیام]";
}

const deleteKeyboard = (id: number): Keyboard => ({
  inline_keyboard: [[{ text: "🗑 حذف از همه گروه‌ها", callback_data: `bd:${id}` }]],
});

async function send(app: App, chatId: number, text: string, markup?: Keyboard): Promise<void> {
  await app.tg.call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(markup ? { reply_markup: markup } : {}),
  });
}

/** Admins only (env ADMIN_IDS plus the admins table). Never falls back to "anyone". */
async function guard(app: App, chatId: number, user: User | undefined): Promise<boolean> {
  if (user && (await isAdmin(app.db, app.adminIds, user.id))) return true;
  const anyAdmin = app.adminIds.size > 0 || (await listAdmins(app.db)).length > 0;
  await send(
    app,
    chatId,
    anyAdmin
      ? "⛔️ شما اجازه ارسال همگانی ندارید."
      : "⛔️ ارسال همگانی هنوز فعال نشده است.\n" +
          (user ? `برای فعال‌سازی، شناسه شما (<code>${user.id}</code>) را در ` : "برای فعال‌سازی، شناسه مدیر را در ") +
          "<code>ADMIN_IDS</code> ربات قرار دهید.",
  );
  return false;
}

/** Ask the admin to confirm sending `source` to every active group. */
async function askConfirm(app: App, userId: number, chatId: number, source: Message): Promise<void> {
  const chats = await listAccounts(app.db, { activeOnly: true });
  if (!chats.length) {
    await clearUserState(app.db, userId);
    return send(app, chatId, "ربات در هیچ گروهی عضو نیست.");
  }
  const data: Source = {
    fromChatId: source.chat.id,
    fromMessageId: source.message_id,
    preview: preview(source),
  };
  await setUserState(app.db, userId, CONFIRM, data, app.now());
  const names = chats.slice(0, 15).map((c) => escapeHtml(accountName(c))).join("، ") + (chats.length > 15 ? " و …" : "");
  await send(
    app,
    chatId,
    `📣 این پیام به <b>${fa(chats.length)} گروه</b> ارسال شود؟\n\n<i>${names}</i>`,
    {
      inline_keyboard: [[
        { text: `✅ ارسال به ${fa(chats.length)} گروه`, callback_data: "bc:go" },
        { text: "❌ انصراف", callback_data: "bc:no" },
      ]],
    },
  );
}

/** /broadcast (private chat, admins); as a reply it broadcasts the replied-to message. */
export async function onBroadcastCommand(app: App, msg: Message): Promise<void> {
  if (!msg.from || !(await guard(app, msg.chat.id, msg.from))) return;
  if (msg.reply_to_message) return askConfirm(app, msg.from.id, msg.chat.id, msg.reply_to_message as Message);
  await setUserState(app.db, msg.from.id, WAITING, {}, app.now());
  const n = (await listAccounts(app.db, { activeOnly: true })).length;
  await send(
    app,
    msg.chat.id,
    `📣 پیامی که می‌خواهید به همه گروه‌ها (${fa(n)} گروه) ارسال شود را بفرستید.\n` +
      "متن، عکس، فایل یا ویدیو — همان‌طور که هست کپی می‌شود.\n\nانصراف: /cancel",
  );
}

/** The next private message while the admin's state is broadcast_waiting. */
export async function onBroadcastCapture(app: App, msg: Message): Promise<void> {
  if (!msg.from) return;
  if (!(await isAdmin(app.db, app.adminIds, msg.from.id))) {
    await clearUserState(app.db, msg.from.id);
    return;
  }
  await clearUserState(app.db, msg.from.id);
  await askConfirm(app, msg.from.id, msg.chat.id, msg);
}

/** /groups (private chat, admins). */
export async function onGroupsCommand(app: App, msg: Message): Promise<void> {
  if (!msg.from || !(await guard(app, msg.chat.id, msg.from))) return;
  const chats = await listAccounts(app.db, { activeOnly: true });
  if (!chats.length) return send(app, msg.chat.id, "ربات هنوز در هیچ گروهی ثبت نشده است.");
  const lines = [`👥 <b>گروه‌های ربات</b> · ${fa(chats.length)} گروه`, ""];
  for (const c of chats) {
    lines.push(`${c.botStatus === "member" ? "👤" : "👑"} ${escapeHtml(accountName(c))}`);
  }
  lines.push("", "👑 ادمین · 👤 عضو");
  await send(app, msg.chat.id, lines.join("\n"));
}

/** /cancel of a pending broadcast. */
export async function onCancelCommand(app: App, msg: Message): Promise<void> {
  let active = false;
  if (msg.from) {
    const st = await getUserState(app.db, msg.from.id);
    if (st?.state === WAITING || st?.state === CONFIRM) {
      await clearUserState(app.db, msg.from.id);
      active = true;
    }
  }
  await send(app, msg.chat.id, active ? "لغو شد." : "کاری برای لغو وجود ندارد.");
}

// --- buttons --------------------------------------------------------------------

async function answer(app: App, q: CallbackQuery, text?: string, alert = false): Promise<void> {
  await app.tg.call("answerCallbackQuery", {
    callback_query_id: q.id,
    ...(text ? { text, ...(alert ? { show_alert: true } : {}) } : {}),
  });
}

async function editMessage(app: App, chatId: number, msgId: number, text: string, markup: Keyboard | null): Promise<void> {
  try {
    await app.tg.call("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text,
      parse_mode: "HTML",
      reply_markup: markup ?? { inline_keyboard: [] },
    });
  } catch (e) {
    if (!isNotModified(e)) throw e;
  }
}

async function setMarkup(app: App, chatId: number, msgId: number, markup: Keyboard | null): Promise<void> {
  try {
    await app.tg.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: markup ?? { inline_keyboard: [] },
    });
  } catch (e) {
    if (!isNotModified(e)) throw e;
  }
}

/** bc:go / bc:no (confirm the pending message) and bd / bdy / bdn (delete a sent broadcast). */
export async function handleBroadcastCallback(app: App, q: CallbackQuery): Promise<void> {
  if (!(await isAdmin(app.db, app.adminIds, q.from.id))) return answer(app, q, NOT_ALLOWED, true);
  const msg = q.message;
  const m = /^(bc|bd|bdy|bdn):(go|no|\d+)$/.exec(q.data ?? "");
  if (!m || !msg) return answer(app, q);
  const chatId = msg.chat.id;
  const msgId = msg.message_id;
  const [, kind, arg] = m;

  if (kind === "bc") {
    if (arg === "no") {
      await clearUserState(app.db, q.from.id);
      await answer(app, q);
      return editMessage(app, chatId, msgId, "❌ ارسال همگانی لغو شد.", null);
    }
    const source = (await takeUserState(app.db, q.from.id, CONFIRM)) as Source | null;
    if (!source) return answer(app, q, "این درخواست منقضی شده است؛ دوباره /broadcast بزنید.", true);
    await createBroadcast(app.db, {
      ...source,
      createdBy: who(q.from),
      createdById: q.from.id,
      createdAt: app.now(),
      statusChatId: chatId,
      statusMsgId: msgId,
    });
    await answer(app, q, "در حال ارسال…");
    await editMessage(app, chatId, msgId, "⏳ در حال ارسال…", null);
    app.defer(runBroadcastBatch(app));
    return;
  }

  const id = Number(arg);
  if (kind === "bd") {
    await answer(app, q);
    return setMarkup(app, chatId, msgId, {
      inline_keyboard: [[
        { text: "⚠️ بله، از همه گروه‌ها حذف شود", callback_data: `bdy:${id}` },
        { text: "↩️ بازگشت", callback_data: `bdn:${id}` },
      ]],
    });
  }
  if (kind === "bdn") {
    await answer(app, q);
    return setMarkup(app, chatId, msgId, deleteKeyboard(id));
  }
  // bdy
  if (!(await startBroadcastDelete(app.db, id, app.now()))) {
    await answer(app, q, "این پیام قبلاً حذف شده است.");
    return setMarkup(app, chatId, msgId, null);
  }
  await answer(app, q, "در حال حذف…");
  await setMarkup(app, chatId, msgId, null);
  app.defer(runBroadcastBatch(app));
}

// --- batches --------------------------------------------------------------------

/** Counts Telegram calls so one invocation stays within BATCH_SIZE subrequests. */
class Budget {
  left = BATCH_SIZE;
  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
}

async function renderReport(app: App, b: Broadcast): Promise<{ text: string; sent: number }> {
  const r = await broadcastReport(app.db, b.id);
  const lines = [
    `📣 <b>ارسال همگانی #${fa(b.id)}</b>`,
    `✅ ارسال شد: ${fa(r.sent)} از ${fa(r.total)} گروه`,
  ];
  if (r.total - r.sent > 0) {
    lines.push(`⚠️ ناموفق: ${fa(r.total - r.sent)}`);
    lines.push(...r.failed.map((f) => `  • ${escapeHtml(f.title)} — <i>${escapeHtml(f.error)}</i>`));
  }
  if (b.status === "deleted") {
    let s = `\n🗑 حذف شد از ${fa(r.deleted)} گروه`;
    if (r.deleteFailed) s += ` · ناموفق: ${fa(r.deleteFailed)} (پیام‌های قدیمی‌تر از ۴۸ ساعت قابل حذف نیستند)`;
    lines.push(s);
  }
  return { text: lines.join("\n"), sent: r.sent };
}

type Outcome = "ok" | "stop";

/** Copy to one group. A group that migrated is retried once at its new id. */
async function copyOne(app: App, w: { broadcastId: number; chatId: number; fromChatId: number; fromMessageId: number }, budget: Budget): Promise<Outcome> {
  let chatId = w.chatId;
  let migrated = false;
  for (;;) {
    if (!budget.take()) return "stop";
    try {
      const res = await app.tg.call<{ message_id: number }>("copyMessage", {
        chat_id: chatId,
        from_chat_id: w.fromChatId,
        message_id: w.fromMessageId,
      });
      await setDelivery(app.db, w.broadcastId, chatId, "queued", "sent", { messageId: res.message_id });
      return "ok";
    } catch (e) {
      if (!(e instanceof TgError)) throw e;
      if (e.retryAfter !== undefined) return "stop";
      if (e.migrateTo && !migrated) {
        await migrateChat(app.db, chatId, e.migrateTo);
        chatId = e.migrateTo;
        migrated = true;
        continue;
      }
      let error = e.message;
      if (isForbidden(e)) {
        error = FORBIDDEN_ERROR;
        await updateAccount(app.db, chatId, { botStatus: "left", updatedAt: app.now() });
      }
      await setDelivery(app.db, w.broadcastId, chatId, "queued", "failed", { error });
      return "ok";
    }
  }
}

async function deleteOne(app: App, w: { broadcastId: number; chatId: number; messageId: number | null }, budget: Budget): Promise<Outcome> {
  if (w.messageId === null) {
    await setDelivery(app.db, w.broadcastId, w.chatId, "delete_queued", "delete_failed", { error: "no message" });
    return "ok";
  }
  if (!budget.take()) return "stop";
  try {
    await app.tg.call("deleteMessage", { chat_id: w.chatId, message_id: w.messageId });
    await setDelivery(app.db, w.broadcastId, w.chatId, "delete_queued", "deleted");
  } catch (e) {
    if (!(e instanceof TgError)) throw e;
    if (e.retryAfter !== undefined) return "stop";
    await setDelivery(app.db, w.broadcastId, w.chatId, "delete_queued", "delete_failed", { error: e.message });
  }
  return "ok";
}

/** Close broadcasts whose queue drained and update their status message (one call each). */
async function finishDrained(app: App, budget: Budget): Promise<void> {
  for (const b of await drainedBroadcasts(app.db)) {
    if (budget.left <= 0) return;
    const to = b.status === "sending" ? "done" : "deleted";
    if (!(await setBroadcastStatus(app.db, b.id, b.status, to))) continue;
    if (b.statusChatId === null || b.statusMsgId === null) continue;
    const { text, sent } = await renderReport(app, { ...b, status: to });
    budget.take();
    try {
      await editMessage(app, b.statusChatId, b.statusMsgId, text, to === "done" && sent ? deleteKeyboard(b.id) : null);
    } catch (e) {
      if (!(e instanceof TgError)) throw e;
    }
  }
}

/**
 * One cron/deferred step: copy or delete up to BATCH_SIZE messages (final status edits included),
 * oldest first. A Telegram rate limit ends the step; the rest stays queued for the next tick.
 */
export async function runBroadcastBatch(app: App): Promise<void> {
  const budget = new Budget();
  // Leave one call free so a finished broadcast always gets its status edit.
  const work = await nextBroadcastWork(app.db, BATCH_SIZE - 1);
  for (const w of work) {
    if (budget.left <= 1) break;
    const outcome = w.state === "queued" ? await copyOne(app, w, budget) : await deleteOne(app, w, budget);
    if (outcome === "stop") break;
  }
  await finishDrained(app, budget);
}
