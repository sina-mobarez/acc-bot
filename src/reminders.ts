import type { App } from "./app";
import { renderReminder } from "./cards";
import { BATCH_SIZE } from "./constants";
import { accountName, allApprovedByChat, listAccounts, migrateChat, updateAccount } from "./db";
import { NUDGE_LINES, pick } from "./jokes";
import { debts, openDeals, summarize } from "./ledger";
import { isForbidden, TgError } from "./telegram";

const TEHRAN_OFFSET_MS = 3.5 * 3600_000;
const DAY_MS = 86_400_000;
const REMIND_FROM_HOUR = 10;

/** Send each debtor group its daily reminder (at most BATCH_SIZE chats per call; later calls continue). */
export async function runReminders(app: App, at: Date): Promise<{ sent: number; remaining: number }> {
  const tehran = new Date(at.getTime() + TEHRAN_OFFSET_MS);
  if (tehran.getUTCHours() < REMIND_FROM_HOUR) return { sent: 0, remaining: 0 };
  const today = tehran.toISOString().slice(0, 10);
  const dayNumber = Math.floor(tehran.getTime() / DAY_MS);

  const due = (await listAccounts(app.db, { activeOnly: true }))
    .filter((a) => a.remindersOn && a.remindedOn !== today)
    .sort((a, b) => a.chatId - b.chatId);
  const batch = due.slice(0, BATCH_SIZE);
  if (!batch.length) return { sent: 0, remaining: 0 };

  const ledgers = await allApprovedByChat(app.db);
  let sent = 0;
  let handled = 0;
  const reminded: number[] = [];

  try {
    for (const account of batch) {
      let chatId = account.chatId;
      const entries = ledgers.get(chatId) ?? [];
      const acc = summarize(entries.map((e) => e.trade));
      if (debts(acc).some(([, v]) => v.gt(0))) {
        const text = renderReminder(
          accountName(account),
          acc,
          openDeals(entries),
          pick(NUDGE_LINES, chatId + dayNumber),
        );
        const send = () => app.tg.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
        try {
          try {
            await send();
          } catch (e) {
            if (!(e instanceof TgError) || !e.migrateTo) throw e;
            await migrateChat(app.db, chatId, e.migrateTo);
            chatId = e.migrateTo;
            await send();
          }
          sent++;
        } catch (e) {
          if (e instanceof TgError && e.retryAfter !== undefined) break; // rate limited: continue next minute
          if (isForbidden(e)) {
            await updateAccount(app.db, chatId, { botStatus: "left" });
            handled++;
            continue;
          }
          console.error("reminder failed", chatId, e);
        }
      }
      reminded.push(chatId);
      handled++;
    }
  } finally {
    // One batched D1 call instead of one per chat keeps the subrequest count low.
    if (reminded.length) {
      await app.db.batch(
        reminded.map((id) => app.db.prepare("UPDATE accounts SET reminded_on = ? WHERE chat_id = ?").bind(today, id)),
      );
    }
  }
  return { sent, remaining: due.length - handled };
}
