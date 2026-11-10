import type { Message, Update } from "@grammyjs/types";
import type { App } from "../app";
import { onBroadcastCapture } from "../broadcast";
import { getSetting, getUserState, isAdmin, markUpdateSeen, migrateChat, upsertAccount } from "../db";
import { handleCallback } from "./callback";
import { handleCommand } from "./commands";
import { handleMessage } from "./message";
import { handleTxScan, hasWallet, txScanTarget } from "./txscan";

export async function botInfo(app: App): Promise<{ id: number; username: string }> {
  const [id, username] = await Promise.all([getSetting(app.db, "bot_id"), getSetting(app.db, "bot_username")]);
  return { id: Number(id ?? 0), username: username ?? "" };
}

/**
 * The text the bot should act on, or null if the message isn't for it. A mention is stripped;
 * a reply to the bot or a leading '#' is kept as-is.
 */
export function isAddressed(msg: Message, bot: { id: number; username: string }): { text: string } | null {
  const text = msg.text;
  if (text === undefined) return null;
  const handle = `@${bot.username}`.toLowerCase();
  const mentions = (msg.entities ?? []).filter(
    (e) =>
      (e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === handle) ||
      (e.type === "text_mention" && e.user.id === bot.id),
  );
  if (mentions.length > 0) {
    // Cut from the end so earlier offsets stay valid.
    let out = text;
    for (const e of [...mentions].sort((a, b) => b.offset - a.offset)) {
      out = out.slice(0, e.offset) + out.slice(e.offset + e.length);
    }
    return { text: out.replace(/\s+/g, " ").trim() };
  }
  if (msg.reply_to_message?.from?.id === bot.id) return { text };
  if (text.startsWith("#")) return { text };
  return null;
}

/** Commands a stranger may use in a private chat, so the owner can learn their id before ADMIN_IDS is set. */
const PUBLIC_COMMANDS = new Set(["id", "help", "start"]);

const commandName = (text: string): string => text.trim().split(/\s+/)[0].slice(1).split("@")[0].toLowerCase();

/**
 * Strangers don't use the bot: in a private chat a non-admin gets only /id and /help, and a group
 * is served only once an admin has spoken or acted there (accounts.activated). Silence costs no
 * Gemini or Nobitex call.
 */
export async function handleUpdate(app: App, u: Update): Promise<void> {
  try {
    if (!(await markUpdateSeen(app.db, u.update_id, app.now()))) return;

    const msg = u.message;
    if (msg?.migrate_to_chat_id !== undefined) {
      await migrateChat(app.db, msg.chat.id, msg.migrate_to_chat_id);
      return;
    }
    const fromAdmin = !!msg?.from && (await isAdmin(app.db, app.adminIds, msg.from.id));
    let activated = false;
    if (msg && (msg.chat.type === "group" || msg.chat.type === "supergroup")) {
      ({ activated } = await upsertAccount(app.db, {
        chatId: msg.chat.id, title: msg.chat.title, type: msg.chat.type, at: app.now(), activated: fromAdmin,
      }));
    }

    const mcm = u.my_chat_member;
    if (mcm) {
      // Private chats (e.g. a user blocking the bot) and channels are not accounts.
      if (mcm.chat.type !== "group" && mcm.chat.type !== "supergroup") return;
      await upsertAccount(app.db, {
        chatId: mcm.chat.id,
        title: mcm.chat.title,
        type: mcm.chat.type,
        at: app.now(),
        botStatus: mcm.new_chat_member.status,
        // An admin adding the bot to a group activates it.
        activated: await isAdmin(app.db, app.adminIds, mcm.from.id),
      });
      return;
    }

    if (u.callback_query) {
      await handleCallback(app, u.callback_query);
      return;
    }
    if (!msg) return;

    if (msg.chat.type === "private") {
      if (!fromAdmin && !(msg.text?.startsWith("/") && PUBLIC_COMMANDS.has(commandName(msg.text)))) return;
    } else if (!activated) {
      return; // a group no admin has spoken in yet: silent for everyone
    }

    if (msg.chat.type !== "private") {
      const target = txScanTarget(msg, await botInfo(app), fromAdmin);
      if (target && (await hasWallet(app, target.ref.networks))) {
        await handleTxScan(app, msg, target);
        return;
      }
    }

    if (msg.text?.startsWith("/")) {
      await handleCommand(app, msg);
      return;
    }

    if (msg.chat.type === "private" && msg.from) {
      const st = await getUserState(app.db, msg.from.id);
      if (st?.state === "broadcast_waiting") {
        await onBroadcastCapture(app, msg);
        return;
      }
    }

    if (msg.text === undefined) return;
    if (msg.chat.type === "private") {
      await handleMessage(app, msg, msg.text);
      return;
    }
    const addressed = isAddressed(msg, await botInfo(app));
    if (addressed) await handleMessage(app, msg, addressed.text);
  } catch (e) {
    console.error("handleUpdate failed", u.update_id, e);
  }
}
