import type { Message, Update } from "@grammyjs/types";
import type { App } from "../app";
import { onBroadcastCapture } from "../broadcast";
import { getSetting, getUserState, markUpdateSeen, migrateChat, upsertAccount } from "../db";
import { handleCallback } from "./callback";
import { handleCommand } from "./commands";
import { handleMessage } from "./message";

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

export async function handleUpdate(app: App, u: Update): Promise<void> {
  try {
    if (!(await markUpdateSeen(app.db, u.update_id, app.now()))) return;

    const msg = u.message;
    if (msg?.migrate_to_chat_id !== undefined) {
      await migrateChat(app.db, msg.chat.id, msg.migrate_to_chat_id);
      return;
    }
    if (msg && (msg.chat.type === "group" || msg.chat.type === "supergroup")) {
      await upsertAccount(app.db, { chatId: msg.chat.id, title: msg.chat.title, type: msg.chat.type, at: app.now() });
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
      });
      return;
    }

    if (u.callback_query) {
      await handleCallback(app, u.callback_query);
      return;
    }
    if (!msg) return;

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
