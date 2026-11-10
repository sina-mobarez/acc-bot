/**
 * Transaction scan: a USDT hash posted in a client group becomes a pending PAY/RECEIVE card.
 * Linked to the replied-to deal card when it fits; otherwise an admin picks the deal from buttons.
 * Clients may trigger the scan (the card still needs an admin's ✅); only admins press the picker.
 */
import type { CallbackQuery, Message } from "@grammyjs/types";
import type { App } from "../app";
import { entryKeyboard, renderEntry, renderTxScan, txPickerKeyboard } from "../cards";
import { findTxHash, type HashRef, lookupTx, type Network, type TxInfo } from "../chain";
import {
  approvedLedger, createEntry, createTxScan, dealCode, DuplicateTxError, type Entry, findActiveByTx, findByCardMessage, getEntry,
  getSetting, releaseTxScan, setCardMessage, takeTxScan, transition, type TxMeta, type TxScan,
} from "../db";
import { allocate, type Leg, openDeals } from "../ledger";
import {
  classify, DEAL_MISFIT, dealFit, DUPLICATE, LOOKUP_ERROR, NOT_FOUND, parseWallet, warnings,
} from "../txscan";
import { ALREADY, answer, editText, NOT_FOUND as ENTRY_NOT_FOUND } from "./callback";
import { ORPHAN_ACTOR, send, sendCard, who } from "./message";
import { isAddressed } from "./update";

export interface ScanTarget {
  ref: HashRef;
  /** The bot message the sender replied to (maybe a deal card), else null. */
  dealMsgId: number | null;
}

/** Whether a group message asks for a scan, and of which hash. `#` and `/` messages never do. */
export function txScanTarget(msg: Message, bot: { id: number; username: string }, fromAdmin: boolean): ScanTarget | null {
  const text = msg.text;
  if (text === undefined || /^\s*[#/]/.test(text)) return null;
  const own = findTxHash(text);
  const replied = msg.reply_to_message;
  if (own) {
    return { ref: own, dealMsgId: replied && replied.from?.id === bot.id ? replied.message_id : null };
  }
  // An admin tagging the bot on someone else's hash message. Telegram doesn't nest replies, so
  // whether that message answered a deal card is unknown: the deal is picked from buttons.
  if (fromAdmin && replied?.text && msg.reply_to_message?.from?.id !== bot.id) {
    const mentioned = isAddressed({ ...msg, reply_to_message: undefined } as Message, bot) !== null;
    const ref = findTxHash(replied.text);
    if (mentioned && ref) return { ref, dealMsgId: null };
  }
  return null;
}

/** Whether a wallet is set for any of these networks; with none there is nothing to check, so it isn't a scan. */
export async function hasWallet(app: App, networks: Network[]): Promise<boolean> {
  for (const n of networks) if ((await wallet(app, n)) !== null) return true;
  return false;
}

const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

async function wallet(app: App, network: Network): Promise<string | null> {
  const raw = await getSetting(app.db, network === "TRON" ? "wallet_tron" : "wallet_bsc");
  return raw ? parseWallet(network, raw) : null;
}

/** The deal's USDT leg in the payment's direction after approved payments, or null. */
async function legOf(app: App, deal: Entry, side: "RECEIVE" | "PAY"): Promise<Leg | null> {
  if (deal.status !== "approved") return null;
  const dir: Leg["dir"] = side === "RECEIVE" ? "client_owes" : "we_owe";
  const legs = allocate(await approvedLedger(app.db, deal.chatId)).get(deal.id) ?? [];
  return legs.find((l) => l.asset === "USDT" && l.dir === dir) ?? null;
}

function metaOf(tx: TxInfo, counterparty: string, warn: string[]): TxMeta {
  return {
    network: tx.network, hash: tx.hash, counterparty, confirmations: tx.confirmations, final: tx.final,
    fee: tx.fee, feeAsset: tx.feeAsset, warnings: warn,
  };
}

async function duplicateText(app: App, network: Network, hash: string, chatId: number): Promise<string | null> {
  const existing = await findActiveByTx(app.db, network, hash);
  if (!existing) return null;
  return DUPLICATE(existing.chatId === chatId ? existing.code : null);
}

export async function handleTxScan(app: App, msg: Message, target: ScanTarget): Promise<void> {
  const c = { app, msg, chatId: msg.chat.id };
  const found = await lookupTx(target.ref, app.fetch, app.env);
  if (found.kind === "not_found") return void (await send(c, NOT_FOUND));
  if (found.kind === "error") return void (await send(c, LOOKUP_ERROR));
  const tx = found.tx;

  const cls = classify(tx, await wallet(app, tx.network));
  if (cls.kind === "refuse") return void (await send(c, cls.text));
  const dup = await duplicateText(app, tx.network, tx.hash, c.chatId);
  if (dup) return void (await send(c, dup));

  let note: string | undefined;
  if (target.dealMsgId !== null) {
    const deal = await findByCardMessage(app.db, c.chatId, target.dealMsgId);
    if (deal && dealFit(deal, cls.side)) {
      const leg = await legOf(app, deal, cls.side);
      const meta = metaOf(tx, cls.counterparty, warnings({ ...tx, amount: cls.amount, deal, leg }));
      let entry: Entry;
      try {
        entry = await createEntry(app.db, {
          chatId: c.chatId,
          trade: { side: cls.side, amount: cls.amount, asset: "USDT", rate: null, note: `هش ${shortHash(tx.hash)}`, tomanTotal: null },
          rawText: msg.text ?? "",
          linkedDealId: deal.id,
          tx: meta,
          sourceMsgId: msg.message_id,
          createdBy: who(msg.from),
          createdById: msg.from?.id ?? 0,
          createdAt: app.now(),
        });
      } catch (e) {
        if (e instanceof DuplicateTxError) return void (await send(c, DUPLICATE(null)));
        throw e;
      }
      await setCardMessage(app.db, entry.id, await sendCard(c, [entry.id], renderEntry(entry), entryKeyboard(entry)));
      return;
    }
    if (deal) note = DEAL_MISFIT;
  }

  // No deal yet: list the open deals that still owe USDT this way, and let an admin pick.
  const dir: Leg["dir"] = cls.side === "RECEIVE" ? "client_owes" : "we_owe";
  const ledger = await approvedLedger(app.db, c.chatId);
  const open = openDeals(ledger).flatMap(({ id, legs }) => {
    const l = legs.find((x) => x.asset === "USDT" && x.dir === dir && x.remaining.gt(0));
    return l ? [{ id, remaining: l.remaining }] : [];
  });
  const scan: Omit<TxScan, "id" | "status"> = {
    chatId: c.chatId,
    side: cls.side,
    amount: cls.amount,
    meta: metaOf(tx, cls.counterparty, warnings({ ...tx, amount: cls.amount, deal: null, leg: null })),
    createdBy: who(msg.from),
    createdById: msg.from?.id ?? 0,
    sourceMsgId: msg.message_id,
    createdAt: app.now(),
  };
  const id = await createTxScan(app.db, scan);
  const deals = open.map((d) => ({ ...d, code: dealCode(d.id) }));
  await send(c, renderTxScan({ ...scan, id, status: "pending" }, note), txPickerKeyboard(id, deals));
}

/** An admin pressed a picker button: `dealId` 0 means "no deal". The admin check is done by the caller. */
export async function handleTxPick(app: App, q: CallbackQuery, scanId: number, dealId: number): Promise<void> {
  const m = q.message;
  if (!m) return answer(app, q);
  const scan = await takeTxScan(app.db, scanId);
  if (!scan) return answer(app, q, ALREADY, true);

  // Until the entry exists, any failure gives the button back.
  let entry: Entry;
  try {
    if (scan.chatId !== m.chat.id) {
      await releaseTxScan(app.db, scanId);
      return answer(app, q, ENTRY_NOT_FOUND, true);
    }
    let deal: Entry | null = null;
    if (dealId !== 0) {
      deal = await getEntry(app.db, dealId);
      if (!deal || deal.chatId !== scan.chatId || !dealFit(deal, scan.side)) {
        await releaseTxScan(app.db, scanId);
        return answer(app, q, ENTRY_NOT_FOUND, true);
      }
    }
    const leg = deal ? await legOf(app, deal, scan.side) : null;
    const meta: TxMeta = { ...scan.meta, warnings: warnings({ ...scan.meta, amount: scan.amount, deal, leg }) };
    try {
      entry = await createEntry(app.db, {
        chatId: scan.chatId,
        trade: { side: scan.side, amount: scan.amount, asset: "USDT", rate: null, note: `هش ${shortHash(meta.hash)}`, tomanTotal: null },
        linkedDealId: deal?.id ?? null,
        tx: meta,
        sourceMsgId: scan.sourceMsgId,
        createdBy: scan.createdBy,
        createdById: scan.createdById,
        createdAt: app.now(),
      });
    } catch (e) {
      if (!(e instanceof DuplicateTxError)) throw e;
      await editText(app, m.chat.id, m.message_id, DUPLICATE(null), null);
      return answer(app, q, DUPLICATE(null), true);
    }
  } catch (e) {
    await releaseTxScan(app.db, scanId);
    throw e;
  }

  // The entry exists: if its card can't be shown, cancel it (as sendCard does) and give the button back,
  // so no pending entry is left without ✅/❌ and the admin can simply press again.
  try {
    await setCardMessage(app.db, entry.id, m.message_id);
    await editText(app, m.chat.id, m.message_id, renderEntry(entry), entryKeyboard(entry));
  } catch (e) {
    await transition(app.db, [entry.id], "pending", "cancelled", { cancelledBy: ORPHAN_ACTOR, cancelledAt: app.now() });
    await releaseTxScan(app.db, scanId);
    throw e;
  }
  await answer(app, q);
}
