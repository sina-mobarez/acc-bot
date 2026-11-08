import type { CallbackQuery, Message, User } from "@grammyjs/types";
import type { App } from "./app";
import { escapeHtml, type Keyboard } from "./cards";
import { Budget } from "./constants";
import {
  accountName, type Broadcast, DELIVERIES_PER_STATEMENT, type Delivery, broadcastReport, clearUserState, createBroadcast, drainedBroadcasts,
  getUserState, hasActiveBroadcast, isAdmin, listAccounts, listAdmins, migrateChat, nextBroadcastWork, recordDeliveries,
  setBroadcastStatus, setUserState, startBroadcastDelete, takeUserState, updateAccount,
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
    await answer(app, q, "در صف ارسال قرار گرفت.");
    // The every-minute cron sends it: one sender, so no double copies and no webhook budget overrun (R23).
    await editMessage(app, chatId, msgId, "⏳ در صف ارسال؛ ارسال تا حدود یک دقیقه‌ی دیگر شروع می‌شود…", null);
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
  await answer(app, q, "در صف حذف قرار گرفت؛ تا حدود یک دقیقه‌ی دیگر شروع می‌شود.");
  await setMarkup(app, chatId, msgId, null);
}

// --- batches --------------------------------------------------------------------

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

/** Budget kept back for closing a broadcast: drained query, status report (2), edit, status flip. */
const FINISH_RESERVE = 5;
/** D1 statements to close one broadcast: report (2) + status flip. The edit is a Telegram call. */
const FINISH_COST = 4;

interface Work {
  broadcastId: number;
  chatId: number;
  messageId: number | null;
  state: "queued" | "delete_queued";
  fromChatId: number;
  fromMessageId: number;
}

/** Copy to one group. A group that migrated is retried once at its new id. Returns null when rate limited. */
async function copyOne(app: App, w: Work, budget: Budget, spare: () => number): Promise<Delivery | null> {
  let chatId = w.chatId;
  let migrated = false;
  for (;;) {
    if (spare() < 1) return null;
    budget.take();
    try {
      const res = await app.tg.call<{ message_id: number }>("copyMessage", {
        chat_id: chatId,
        from_chat_id: w.fromChatId,
        message_id: w.fromMessageId,
      });
      return { broadcastId: w.broadcastId, chatId, to: "sent", messageId: res.message_id };
    } catch (e) {
      if (!(e instanceof TgError)) throw e;
      if (e.retryAfter !== undefined) return null;
      if (e.migrateTo && !migrated) {
        if (spare() < 5) return null; // migrateChat is a 5-statement batch
        budget.take(5);
        await migrateChat(app.db, chatId, e.migrateTo);
        chatId = e.migrateTo;
        migrated = true;
        continue;
      }
      let error = e.message;
      if (isForbidden(e)) {
        error = FORBIDDEN_ERROR;
        if (spare() >= 1) {
          budget.take();
          await updateAccount(app.db, chatId, { botStatus: "left", updatedAt: app.now() });
        }
      }
      return { broadcastId: w.broadcastId, chatId, to: "failed", error };
    }
  }
}

async function deleteOne(app: App, w: Work, budget: Budget, spare: () => number): Promise<Delivery | null> {
  const row = { broadcastId: w.broadcastId, chatId: w.chatId };
  if (w.messageId === null) return { ...row, to: "delete_failed", error: "no message" };
  if (spare() < 1) return null;
  budget.take();
  try {
    await app.tg.call("deleteMessage", { chat_id: w.chatId, message_id: w.messageId });
    return { ...row, to: "deleted" };
  } catch (e) {
    if (!(e instanceof TgError)) throw e;
    if (e.retryAfter !== undefined) return null;
    return { ...row, to: "delete_failed", error: e.message };
  }
}

/** A failed status edit worth retrying next tick (rate limit, server error); anything else will not get better. */
const isTransient = (e: TgError): boolean => e.retryAfter !== undefined || e.code === 429 || e.code >= 500;

/**
 * Close broadcasts whose queue drained: edit the status message first, flip the status only once
 * the edit landed (or can never land), so a failed edit is retried by the next tick.
 */
async function finishDrained(app: App, budget: Budget): Promise<void> {
  if (!budget.take()) return;
  for (const b of await drainedBroadcasts(app.db)) {
    if (!budget.take(FINISH_COST)) return;
    const to = b.status === "sending" ? "done" : "deleted";
    if (b.statusChatId !== null && b.statusMsgId !== null) {
      const { text, sent } = await renderReport(app, { ...b, status: to });
      try {
        await editMessage(app, b.statusChatId, b.statusMsgId, text, to === "done" && sent ? deleteKeyboard(b.id) : null);
      } catch (e) {
        if (!(e instanceof TgError)) throw e;
        if (isTransient(e)) {
          if (e.retryAfter !== undefined) return;
          continue;
        }
      }
    }
    await setBroadcastStatus(app.db, b.id, b.status, to);
  }
}

/**
 * One cron step, charged to `budget` (Telegram calls and D1 statements alike): copy or delete
 * queued messages oldest first, record the outcomes in a few batched statements, then close drained
 * broadcasts. A Telegram rate limit ends the step; the rest stays queued for the next tick.
 */
export async function runBroadcastBatch(app: App, budget: Budget = new Budget()): Promise<void> {
  // Most ticks have nothing to do: one cheap query on the small broadcasts table, then stop.
  if (!budget.take() || !(await hasActiveBroadcast(app.db))) return;
  // Rows fetched n: n Telegram calls + ceil(n / per-statement) outcome writes, within what is left
  // after the work query and the closing reserve.
  const avail = budget.left - 1 - FINISH_RESERVE;
  let n = 0;
  while (n + 1 + Math.ceil((n + 1) / DELIVERIES_PER_STATEMENT) <= avail) n++;
  const results: Delivery[] = [];
  if (n > 0 && budget.take()) {
    const work = await nextBroadcastWork(app.db, n);
    const writes = Math.ceil(work.length / DELIVERIES_PER_STATEMENT);
    // Everything beyond the final writes and the closing reserve may be spent on Telegram calls and migrations.
    const spare = () => budget.left - writes - FINISH_RESERVE;
    try {
      for (const w of work) {
        const d = w.state === "queued" ? await copyOne(app, w, budget, spare) : await deleteOne(app, w, budget, spare);
        if (!d) break;
        results.push(d);
      }
    } finally {
      if (results.length) {
        budget.take(Math.ceil(results.length / DELIVERIES_PER_STATEMENT));
        await recordDeliveries(app.db, results);
      }
    }
  }
  await finishDrained(app, budget);
}
