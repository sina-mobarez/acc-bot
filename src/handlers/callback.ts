import type { CallbackQuery, User } from "@grammyjs/types";
import Decimal from "decimal.js";
import type { App } from "../app";
import { handleBroadcastCallback } from "../broadcast";
import {
  debtLine, entryKeyboard, type Keyboard, renderEditApplied, renderEntry, renderSettlement, settlementKeyboard,
} from "../cards";
import {
  approvedLedger, cancelEntry, editChangesFromPayload, editEntry, type Entry, entriesInBatch, getEntry, getPendingAction, isAdmin,
  type PendingAction, releasePendingAction, takePendingAction, transition, unlinkPayments,
} from "../db";
import { allocate, debts, summarize } from "../ledger";
import { applyTradeEdit } from "../parser";
import { isNotModified, TgError } from "../telegram";
import { handleTxPick } from "./txscan";
import { isPayment } from "../trade";

const NOT_ALLOWED = "شما اجازه این کار را ندارید.";
export const ALREADY = "این مورد قبلاً بررسی شده است.";
export const NOT_FOUND = "این مورد پیدا نشد.";
const NOT_EDITABLE = "این مورد دیگر قابل ویرایش نیست.";
export const STALE_SETTLEMENT =
  "معامله‌ی مرتبط قبلاً (به‌طور کامل یا جزئی) تسویه شده است؛ این تسویه رد شد. در صورت نیاز دوباره تسویه را صادر کنید.";
export const UNLINKED_NOTE = "پرداخت‌های مرتبط باقی ماندند و به حساب کلی برگشتند";

const who = (u: User): string =>
  u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ");

interface Ctx {
  app: App;
  q: CallbackQuery;
  chatId: number;
  msgId: number;
  actor: string;
}

export async function answer(app: App, q: CallbackQuery, text?: string, alert = false): Promise<void> {
  await app.tg.call("answerCallbackQuery", {
    callback_query_id: q.id,
    ...(text ? { text, ...(alert ? { show_alert: true } : {}) } : {}),
  });
}

export async function editText(
  app: App, chatId: number, msgId: number, text: string, keyboard: Keyboard | null,
): Promise<void> {
  try {
    await app.tg.call("editMessageText", {
      chat_id: chatId,
      message_id: msgId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard ?? { inline_keyboard: [] },
    });
  } catch (e) {
    if (!isNotModified(e)) throw e;
  }
}

/** Re-render the clicked card (or its whole settlement batch) in its current state. */
async function showCard(c: Ctx, entry: Entry, extra = "", confirmCancel = false): Promise<void> {
  const { app } = c;
  const fresh = (await getEntry(app.db, entry.id)) ?? entry;
  let text: string;
  let keyboard: Keyboard | null;
  const deal = fresh.batchId && fresh.linkedDealId !== null ? await getEntry(app.db, fresh.linkedDealId) : null;
  const payments = deal && fresh.batchId ? await entriesInBatch(app.db, fresh.batchId) : [];
  if (deal && payments.length) {
    text = renderSettlement(deal, payments);
    keyboard = payments[0].status === "pending" ? settlementKeyboard(payments[0].id) : null;
  } else {
    text = renderEntry(fresh, { confirmCancel });
    keyboard = entryKeyboard(fresh, confirmCancel);
  }
  await editText(app, c.chatId, c.msgId, extra ? `${text}\n\n${extra}` : text, keyboard);
}

/** R18: every payment of a settlement batch must still fit in its deal's matching leg. */
export async function settlementStillValid(app: App, chatId: number, batch: Entry[]): Promise<boolean> {
  // Sum the batch per (deal, asset, direction): several payments may hit the same leg.
  const needed = new Map<string, { dealId: number; asset: string; dir: string; sum: Decimal }>();
  for (const p of batch) {
    if (!isPayment(p.trade) || p.linkedDealId === null) continue;
    const dir = p.trade.side === "RECEIVE" ? "client_owes" : "we_owe";
    const key = `${p.linkedDealId}|${p.trade.asset}|${dir}`;
    const cur = needed.get(key);
    if (cur) cur.sum = cur.sum.plus(p.trade.amount);
    else needed.set(key, { dealId: p.linkedDealId, asset: p.trade.asset, dir, sum: p.trade.amount });
  }
  if (!needed.size) return true;
  const legsByDeal = allocate(await approvedLedger(app.db, chatId));
  return [...needed.values()].every((n) => {
    const leg = legsByDeal.get(n.dealId)?.find((l) => l.asset === n.asset && l.dir === n.dir);
    return !!leg && leg.remaining.gte(n.sum);
  });
}

export type DecideResult = "done" | "already" | "stale";

/**
 * Approve or reject an entry together with its settlement batch (all or nothing). An approval
 * whose settlement no longer fits (R18) rejects the batch instead and returns "stale".
 * Shared by the Telegram buttons and the Mini App API.
 */
export async function decideEntry(
  app: App, entry: Entry, to: "approved" | "rejected", actor: string,
): Promise<DecideResult> {
  const batch = entry.batchId ? await entriesInBatch(app.db, entry.batchId) : [entry];
  const ids = batch.map((e) => e.id);
  const fields = { decidedBy: actor, decidedAt: app.now() };

  if (
    to === "approved" &&
    batch.every((e) => e.status === "pending") &&
    !(await settlementStillValid(app, entry.chatId, batch))
  ) {
    await transition(app.db, ids, "pending", "rejected", fields);
    return "stale";
  }
  return (await transition(app.db, ids, "pending", to, fields)) ? "done" : "already";
}

async function decide(c: Ctx, entry: Entry, to: "approved" | "rejected"): Promise<void> {
  const { app } = c;
  const r = await decideEntry(app, entry, to, c.actor);
  if (r === "already") return answer(app, c.q, ALREADY, true);
  await showCard(c, entry);
  if (r === "stale") return answer(app, c.q, STALE_SETTLEMENT, true);
  await answer(app, c.q);
}

/** Cancel a pending entry (and its whole settlement batch). False if it was no longer pending. */
export async function cancelPending(app: App, entry: Entry, actor: string): Promise<boolean> {
  const ids = (entry.batchId ? await entriesInBatch(app.db, entry.batchId) : [entry]).map((e) => e.id);
  const at = app.now();
  return ids.length === 1
    ? cancelEntry(app.db, entry.id, "pending", actor, at)
    : transition(app.db, ids, "pending", "cancelled", { cancelledBy: actor, cancelledAt: at });
}

/** Cancel an approved entry; approved payments linked to a cancelled deal fall back to FIFO. */
export async function cancelApproved(
  app: App, entry: Entry, actor: string,
): Promise<{ ok: boolean; unlinked: number }> {
  // cancelEntry records the 'cancel' event in the same batch as the status change.
  if (!(await cancelEntry(app.db, entry.id, "approved", actor, app.now()))) return { ok: false, unlinked: 0 };
  const unlinked = isPayment(entry.trade) ? 0 : await unlinkPayments(app.db, entry.id);
  return { ok: true, unlinked };
}

async function cancelRequest(c: Ctx, entry: Entry): Promise<void> {
  const { app } = c;
  if (entry.status === "approved") {
    await showCard(c, entry, "", true);
    return answer(app, c.q);
  }
  if (entry.status !== "pending") return answer(app, c.q, ALREADY, true);
  if (!(await cancelPending(app, entry, c.actor))) return answer(app, c.q, ALREADY, true);
  await showCard(c, entry);
  await answer(app, c.q);
}

async function cancelConfirm(c: Ctx, entry: Entry): Promise<void> {
  const { app } = c;
  const { ok, unlinked } = await cancelApproved(app, entry, c.actor);
  if (!ok) return answer(app, c.q, ALREADY, true);
  const lines: string[] = [];
  if (unlinked > 0) lines.push(`ℹ️ ${UNLINKED_NOTE}`);
  const owed = debts(summarize((await approvedLedger(app.db, c.chatId)).map((l) => l.trade)));
  lines.push("🧮 <b>مانده حساب پس از لغو</b>");
  lines.push(...(owed.every(([, v]) => v.isZero()) ? ["✅ حساب کاملاً تسویه است."] : owed.map(([a, v]) => debtLine(a, v))));
  await showCard(c, entry, lines.join("\n"));
  await answer(app, c.q);
}

/** The still-pending edit action for this chat, or null (after answering the callback). */
async function ownedAction(c: Ctx, actionId: number): Promise<PendingAction | null> {
  const a = await getPendingAction(c.app.db, actionId);
  if (!a || a.kind !== "edit" || a.chatId !== c.chatId) {
    await answer(c.app, c.q, NOT_FOUND, true);
    return null;
  }
  if (a.status !== "pending") {
    await answer(c.app, c.q, ALREADY, true);
    return null;
  }
  return a;
}

async function applyEdit(c: Ctx, actionId: number): Promise<void> {
  const { app } = c;
  const peek = await ownedAction(c, actionId);
  if (!peek) return;
  const entry = await getEntry(app.db, peek.entryId);
  if (!entry || (entry.status !== "pending" && entry.status !== "approved")) {
    // Nothing can ever be applied to it: discard the proposal and say why.
    await takePendingAction(app.db, actionId, "discarded");
    await editText(app, c.chatId, c.msgId, `⚠️ ${NOT_EDITABLE}`, null);
    return answer(app, c.q, NOT_EDITABLE, true);
  }
  const action = await takePendingAction(app.db, actionId, "applied");
  if (!action) return answer(app, c.q, ALREADY, true);
  // Re-apply only the requested changes to the trade as it is now, so edits made since are kept.
  const next = applyTradeEdit(entry.trade, editChangesFromPayload(action.payload));
  let updated: Entry;
  try {
    updated = await editEntry(app.db, entry.id, next, c.actor, app.now());
  } catch (e) {
    await releasePendingAction(app.db, actionId);
    throw e;
  }
  await editText(app, c.chatId, c.msgId, renderEditApplied(updated, entry.trade), null);
  // The original card would otherwise keep showing the old numbers (batch cards are settlements: left alone).
  if (updated.cardMsgId && !updated.batchId) {
    try {
      await editText(app, updated.chatId, updated.cardMsgId, renderEntry(updated), entryKeyboard(updated));
    } catch (e) {
      if (!(e instanceof TgError)) throw e;
    }
  }
  await answer(app, c.q);
}

async function discardEdit(c: Ctx, actionId: number): Promise<void> {
  const { app } = c;
  if (!(await ownedAction(c, actionId))) return;
  if (!(await takePendingAction(app.db, actionId, "discarded"))) return answer(app, c.q, ALREADY, true);
  await editText(app, c.chatId, c.msgId, "🗑 ویرایش انصراف داده شد.", null);
  await answer(app, c.q);
}

/** Inline-button callbacks: approve/reject, cancel (with confirm), settlement batches, edit apply/discard. */
export async function handleCallback(app: App, q: CallbackQuery): Promise<void> {
  if (/^(bc:(go|no)|bd:\d+|bdy:\d+|bdn:\d+)$/.test(q.data ?? "")) return handleBroadcastCallback(app, q);
  if (!(await isAdmin(app.db, app.adminIds, q.from.id))) return answer(app, q, NOT_ALLOWED, true);
  const tp = /^tp:(\d+):(\d+)$/.exec(q.data ?? "");
  if (tp) return handleTxPick(app, q, Number(tp[1]), Number(tp[2]));
  const m = /^(ok|no|cx|cy|cn|ea|ed):(\d+)$/.exec(q.data ?? "");
  const msg = q.message;
  if (!m || !msg) return answer(app, q);
  const c: Ctx = { app, q, chatId: msg.chat.id, msgId: msg.message_id, actor: who(q.from) };
  const id = Number(m[2]);
  const kind = m[1];

  if (kind === "ea") return applyEdit(c, id);
  if (kind === "ed") return discardEdit(c, id);

  const entry = await getEntry(app.db, id);
  if (!entry || entry.chatId !== c.chatId) return answer(app, q, NOT_FOUND, true);
  switch (kind) {
    case "ok": return decide(c, entry, "approved");
    case "no": return decide(c, entry, "rejected");
    case "cx": return cancelRequest(c, entry);
    case "cy": return cancelConfirm(c, entry);
    default: // cn
      await showCard(c, entry);
      return answer(app, q);
  }
}

/** Best-effort short notice in the entry's group (used by the Mini App), replying to its card. */
export async function notifyChange(app: App, entry: Entry, text: string): Promise<void> {
  try {
    await app.tg.call("sendMessage", {
      chat_id: entry.chatId,
      text,
      parse_mode: "HTML",
      ...(entry.cardMsgId ? { reply_parameters: { message_id: entry.cardMsgId, allow_sending_without_reply: true } } : {}),
    });
  } catch (e) {
    if (!(e instanceof TgError)) throw e;
  }
}
