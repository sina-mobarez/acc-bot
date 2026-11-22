/** Task 8: natural-language and `#` message handling: cards, answers, refusals. */
import Decimal from "decimal.js";
import type { Message, User } from "@grammyjs/types";
import type { App } from "../app";
import { matchBank, splitBankNote } from "../banks";
import {
  entryKeyboard, escapeHtml, editKeyboard, type Keyboard, renderAccountRemaining, renderBalance, renderBankMove, renderBanks, renderRefAsk,
  renderDealRemaining, renderEditProposal, renderEntry, renderList, renderPrices, renderSettlement, settlementKeyboard,
} from "../cards";
import {
  type Account, accountName, addBankMove, approvedLedger, type Bank, bankable, bankBalances, bankEffect, createEntry,
  createPaymentDraft, createPendingAction, findPaymentDraft, type PaymentDraft, setDraftAsk, takePaymentDraft, type EditChanges, editPayload, type Entry, findByCardMessage, getAccount, getByCode, getSetting,
  isAdmin, listAccounts, listBanks, recent, setBatch, setCardMessage, setEntryRef, transition,
} from "../db";
import {
  type Action, DEFAULT_DEVIATION_PCT, deviationPct, expandRateShorthand, parseDeviationSetting, toAction,
} from "../intent";
import { BUSY_TEXT, CLIENT_WRITE_REFUSALS, pick } from "../jokes";
import { allocate, openDeals, summarize } from "../ledger";
import { normalize, parseAmountText } from "../money";
import type { NluInput, NluOutput } from "../nlu";
import { applyTradeEdit, cleanRef, parseMessage, splitRef, TradeError } from "../parser";
import { TgError } from "../telegram";
import { type CoinQuote, fetchCoinUsdt, fetchUsdtToman, type UsdtPrice } from "../prices";
import { isPayment, type Trade } from "../trade";

const EMPTY_HINT =
  "جانم؟ 🙂 بگو چه کاری انجام بدهم؛ مثلاً «حساب ما چقدر است؟» یا «قیمت تتر».\n" +
  "ثبت معامله با # هم کار می‌کند: <code>#خرید ۱۰۰۰ تتر ۲۶۴۰۰۰</code>";
const PRIVATE_WRITE =
  "ثبت و تغییر معامله فقط در گروه همان مشتری انجام می‌شود (یا در مینی‌اپ). همان‌جا بنویسید 🙂";
const NOT_FOUND = "پیدا نشد.";
const BANKS_PRIVATE_ONLY = "موجودی بانک‌ها فقط در چت خصوصی با ربات یا پنل مدیریت نمایش داده می‌شود.";

const BAD_REF = "کد پیگیری یا هش تراکنش را متوجه نشدم. دوباره بفرست.";
const DEAL_INTENTS = new Set<NluOutput["intent"]>(["settle_deal", "edit_deal", "cancel_deal", "set_reference"]);
const WRITE_KINDS = new Set<Action["kind"]>(["create", "payment", "settle", "edit", "cancel", "ref"]);
const MAX_LISTED = 30;
/** KuCoin calls per price question (one per coin): keeps a long Gemini coin list inside the subrequest budget. */
const MAX_COINS = 10;

interface Ctx {
  app: App;
  msg: Message;
  chatId: number;
  inGroup: boolean;
  role: "admin" | "client";
  humor: boolean;
  usdt: UsdtPrice | null;
  alertPct: Decimal;
  account: Account | null;
  /** Our own bank accounts; loaded for admins only. */
  banks: Bank[];
}

/** cancelled_by for entries whose card could not be sent. */
export const ORPHAN_ACTOR = "ربات (کارت ارسال نشد)";

/**
 * Send the card for just-created pending entries; if Telegram refuses, cancel them so no
 * pending entry is left without a card to approve it from, then rethrow.
 */
export async function sendCard(c: Pick<Ctx, "app" | "msg" | "chatId">, ids: number[], text: string, keyboard: Keyboard | null): Promise<number> {
  try {
    return await send(c, text, keyboard);
  } catch (e) {
    await transition(c.app.db, ids, "pending", "cancelled", { cancelledBy: ORPHAN_ACTOR, cancelledAt: c.app.now() });
    throw e;
  }
}

export const who = (u: User | undefined): string =>
  !u ? "?" : u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ");

/** Best-effort "typing…" while Gemini (often 7-11 s on the free tier) works. */
function typing(c: Pick<Ctx, "app" | "chatId">): void {
  c.app.defer(c.app.tg.call("sendChatAction", { chat_id: c.chatId, action: "typing" }).catch(() => undefined));
}

export async function send(c: Pick<Ctx, "app" | "msg" | "chatId">, text: string, keyboard?: Keyboard | null): Promise<number> {
  const res = await c.app.tg.call<{ message_id: number }>("sendMessage", {
    chat_id: c.chatId,
    text,
    parse_mode: "HTML",
    reply_parameters: { message_id: c.msg.message_id, allow_sending_without_reply: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
  return res.message_id;
}

/** A non-card reply, with the joke (already filtered by humor) as an italic last line. */
const withJoke = (text: string, joke: string | undefined): string =>
  joke ? `${text}\n\n<i>${escapeHtml(joke)}</i>` : text;

/** Plain-text summary of an entry for the NLU's open-deals list. */
function summary(e: Entry): string {
  const t = e.trade;
  const parts = [t.side, t.amount.toFixed(), t.asset];
  if (t.rate !== null) parts.push("@", t.rate.toFixed());
  if (t.tomanTotal !== null) parts.push(`(toman ${t.tomanTotal.toFixed()})`);
  if (t.note) parts.push("·", t.note);
  parts.push(`[${e.status}]`);
  return parts.join(" ");
}

/** The reference price and deviation of a USDT-priced trade, if Nobitex answered. */
function deviation(c: Ctx, t: Trade): { ref: Decimal; dev: Decimal } | null {
  if (!c.usdt || isPayment(t) || t.rate === null || t.asset !== "USDT") return null;
  return { ref: c.usdt.latest, dev: deviationPct(t.rate, c.usdt.latest) };
}

async function nluInput(c: Ctx, text: string): Promise<NluInput> {
  const open = (await recent(c.app.db, c.chatId, 20))
    .filter((e) => e.status === "pending" || e.status === "approved")
    .map((e) => ({ code: e.code, summary: summary(e) }));
  const input: NluInput = {
    text,
    role: c.role,
    chat: c.inGroup ? "group" : "private",
    repliedText: c.msg.reply_to_message?.text,
    usdtToman: c.usdt?.latest.toFixed(),
    deviationPct: c.alertPct.toFixed(),
    openDeals: open,
  };
  if (c.banks.length) input.bankNames = c.banks.map((b) => b.name);
  if (!c.inGroup && c.role === "admin") {
    input.accountNames = (await listAccounts(c.app.db)).slice(0, 200).map(accountName);
  }
  return input;
}

export async function handleMessage(app: App, msg: Message, text: string): Promise<void> {
  const inGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const role: Ctx["role"] = msg.from && (await isAdmin(app.db, app.adminIds, msg.from.id)) ? "admin" : "client";
  const c0 = { app, msg, chatId: msg.chat.id, inGroup, role };

  if (text.trim() === "") {
    await send(c0, EMPTY_HINT);
    return;
  }

  // A reply to «کد پیگیری را بفرست»: finish that payment. No Gemini, no price lookup.
  const asked = inGroup && role === "admin" ? msg.reply_to_message : undefined;
  if (asked) {
    const draft = await findPaymentDraft(app.db, msg.chat.id, asked.message_id);
    if (draft) return finishDraft(c0, draft, text, asked.message_id);
  }

  const [usdt, account, devSetting, banks] = await Promise.all([
    fetchUsdtToman(app.fetch),
    inGroup ? getAccount(app.db, msg.chat.id) : Promise.resolve(null),
    getSetting(app.db, "deviation_pct"),
    role === "admin" ? listBanks(app.db) : Promise.resolve([]),
  ]);
  const c: Ctx = {
    ...c0,
    usdt,
    account,
    banks,
    humor: inGroup ? (account?.humorOn ?? true) : true,
    alertPct: parseDeviationSetting(devSetting) ?? new Decimal(DEFAULT_DEVIATION_PCT),
  };
  const defaultAsset = app.env.DEFAULT_ASSET || "USDT";

  let action: Action | null = null;
  let joke: string | undefined;
  let out: NluOutput | null = null;

  // 1. Fast path: the `#` grammar.
  if (text.trimStart().startsWith("#")) {
    let trade: Trade | null;
    try {
      trade = parseMessage(text, defaultAsset);
    } catch (e) {
      if (!(e instanceof TradeError)) throw e;
      await send(c, escapeHtml(e.message));
      return;
    }
    if (trade) {
      if (role === "client") {
        await send(c, pick(CLIENT_WRITE_REFUSALS, msg.message_id));
        return;
      }
      action = { kind: isPayment(trade) ? "payment" : "create", trade };
    }
  }

  // 2. Natural language (or a `#` message that didn't parse).
  if (!action) {
    typing(c);
    out = await app.nlu.understand(await nluInput(c, text));
    if (!out) {
      await send(c, BUSY_TEXT);
      return;
    }
    const replied = msg.reply_to_message;
    if (inGroup && replied && DEAL_INTENTS.has(out.intent) && !out.deal_code) {
      const card = await findByCardMessage(app.db, c.chatId, replied.message_id);
      if (card) out = { ...out, deal_code: card.code };
    }
    action = toAction(out, { role, usdtToman: usdt?.latest ?? null, defaultAsset });
    if (action.kind === "reply" && (out.intent === "create_trade" || out.intent === "record_payment")) {
      console.warn("nlu: incomplete write intent", JSON.stringify(out));
    }
    // A joke only ever follows an answer to a question; cards carry none.
    joke = c.humor ? out.joke?.trim() || undefined : undefined;
  }

  // In a private chat an admin's toman payment is a deposit to / withdrawal from one of our banks.
  if (!inGroup && role === "admin" && action.kind === "payment") {
    await bankMove(c, action);
    return;
  }
  if (!inGroup && WRITE_KINDS.has(action.kind)) {
    await send(c, PRIVATE_WRITE);
    return;
  }

  await dispatch(c, action, joke, out, text);
}

async function dispatch(c: Ctx, action: Action, joke: string | undefined, out: NluOutput | null, text: string) {
  const { app, msg } = c;
  switch (action.kind) {
    case "create":
    case "payment": {
      const picked = pickBank(c, action.trade, action.kind === "payment" ? action.bankHint : undefined);
      if (typeof picked === "string") return void (await send(c, picked));
      const withRef = pickRef(picked.trade, action.kind === "payment" ? action.ref : undefined);
      if (!withRef) return void (await send(c, BAD_REF));
      // A payment written as a reply to an approved deal's card belongs to that deal.
      let linkedDealId: number | null = null;
      const replied = msg.reply_to_message;
      if (action.kind === "payment" && replied) {
        const card = await findByCardMessage(app.db, c.chatId, replied.message_id);
        if (card && !isPayment(card.trade) && card.status === "approved") linkedDealId = card.id;
      }
      // With «require_ref» on, a payment is not saved without its tracking code / hash: ask, and wait for the reply.
      if (action.kind === "payment" && withRef.ref === null && (await getSetting(app.db, "require_ref")) === "1") {
        const draftId = await createPaymentDraft(
          app.db,
          { chatId: c.chatId, trade: withRef.trade, bankId: picked.bank?.id ?? null, linkedDealId, rawText: text },
          app.now(),
        );
        await setDraftAsk(app.db, draftId, await send(c, renderRefAsk(withRef.trade, picked.bank?.name ?? null)));
        return;
      }
      const e = await createEntry(app.db, {
        chatId: c.chatId,
        trade: withRef.trade,
        bankId: picked.bank?.id ?? null,
        ref: withRef.ref,
        linkedDealId,
        rawText: text,
        sourceMsgId: msg.message_id,
        createdBy: who(msg.from),
        createdById: msg.from?.id ?? 0,
        createdAt: app.now(),
      });
      const card = renderEntry(e);
      await setCardMessage(app.db, e.id, await sendCard(c, [e.id], card, entryKeyboard(e)));
      return;
    }
    case "settle":
      return settle(c, action.dealCode, action.bankHint);
    case "ref":
      return setRef(c, action);
    case "banks": {
      // Our bank balances never appear in a group, whoever asks.
      if (c.inGroup || c.role !== "admin") return void (await send(c, BANKS_PRIVATE_ONLY));
      const balances = await bankBalances(app.db);
      const rows = c.banks.map((b) => ({ name: b.name, balance: balances.get(b.id) ?? new Decimal(0) }));
      return void (await send(c, renderBanks(rows)));
    }
    case "edit":
      return edit(c, action, out, joke);
    case "cancel": {
      const e = await getByCode(app.db, c.chatId, action.dealCode);
      if (!e) return void (await send(c, notFound(action.dealCode)));
      if (e.status === "approved") {
        await send(c, renderEntry(e, { confirmCancel: true }), entryKeyboard(e, true));
      } else if (e.status === "pending") {
        await send(c, renderEntry(e), entryKeyboard(e));
      } else {
        await send(c, `<code>${e.code}</code> قبلاً ${e.status === "rejected" ? "رد" : "لغو"} شده است.`);
      }
      return;
    }
    case "remaining":
      return remaining(c, action, joke);
    case "balance":
    case "deals": {
      const target = await resolveAccount(c, action.clientHint);
      if (typeof target === "string") return void (await send(c, withJoke(target, joke)));
      let body: string;
      if (action.kind === "balance") {
        const ledger = await approvedLedger(app.db, target.chatId);
        body = renderBalance(target.name, summarize(ledger.map((l) => l.trade)));
      } else {
        body = renderList(target.name, await recent(app.db, target.chatId, 15));
      }
      await send(c, withJoke(body, joke));
      return;
    }
    case "price": {
      const coins = [...new Set(action.coins.map((x) => x.trim().toUpperCase()))]
        .filter((x) => x && x !== "USDT")
        .slice(0, MAX_COINS);
      await send(c, withJoke(renderPrices(c.usdt, await quotes(c, coins)), joke));
      return;
    }
    case "reply":
      await send(c, withJoke(escapeHtml(action.text), joke));
      return;
    case "refuse":
      await send(c, withJoke(pick(CLIENT_WRITE_REFUSALS, msg.message_id), joke));
      return;
  }
}

const bankList = (c: Ctx): string => c.banks.map((b) => escapeHtml(b.name)).join("، ");

/**
 * The bank a toman payment names: the NLU's bank field, else a note that starts with a bank
 * (the `#` grammar: «#دریافت ۵۰ میلیون سامان»). A named bank we don't have is a reply (a string),
 * never a silent card without it. Other assets, and offices with no banks set up, have none.
 */
function pickBank(c: Ctx, trade: Trade, hint: string | undefined): { trade: Trade; bank: Bank | null } | string {
  if (!bankable(trade) || !c.banks.length) return { trade, bank: null };
  if (hint) {
    const bank = matchBank(c.banks, hint);
    return bank ? { trade, bank } : `بانک «${escapeHtml(hint)}» را نمی‌شناسم. بانک‌های تعریف‌شده: ${bankList(c)}`;
  }
  const split = splitBankNote(c.banks, trade.note);
  return split ? { trade: { ...trade, note: split.note }, bank: split.bank } : { trade, bank: null };
}

/**
 * The reference of a new entry: the NLU's ref field, else one written inside the note
 * («… پیگیری ۱۲۳۴۵۶», or a transaction hash), which then leaves the note. null: a ref that isn't a code.
 */
function pickRef(trade: Trade, hint: string | undefined): { trade: Trade; ref: string | null } | null {
  if (hint) {
    const ref = cleanRef(hint);
    return ref ? { trade, ref } : null;
  }
  const split = splitRef(trade.note);
  return split ? { trade: { ...trade, note: split.note }, ref: split.ref } : { trade, ref: null };
}

/** An admin answered the bot's question with the reference: record the drafted payment as a pending card. */
async function finishDraft(
  c: Pick<Ctx, "app" | "msg" | "chatId">, draft: PaymentDraft, text: string, askMsgId: number,
): Promise<void> {
  const { app, msg } = c;
  const ref = cleanRef(text) ?? splitRef(text)?.ref ?? null;
  if (!ref) return void (await send(c, BAD_REF));
  if (!(await takePaymentDraft(app.db, draft.id))) return;
  const e = await createEntry(app.db, {
    chatId: c.chatId,
    trade: draft.trade,
    bankId: draft.bankId,
    linkedDealId: draft.linkedDealId,
    ref,
    rawText: draft.rawText,
    sourceMsgId: msg.message_id,
    createdBy: who(msg.from),
    createdById: msg.from?.id ?? 0,
    createdAt: app.now(),
  });
  await setCardMessage(app.db, e.id, await sendCard(c, [e.id], renderEntry(e), entryKeyboard(e)));
  // The question has done its job; best effort (Telegram refuses for messages over 48 hours old).
  app.defer(app.tg.call("deleteMessage", { chat_id: c.chatId, message_id: askMsgId }).catch(() => undefined));
}

/** «کد پیگیری ۱۲۳۴۵۶» for an existing payment or deal (by code or replied-to card): save it and update the card. */
async function setRef(c: Ctx, action: Extract<Action, { kind: "ref" }>): Promise<void> {
  const { app } = c;
  const e = await getByCode(app.db, c.chatId, action.dealCode);
  if (!e) return void (await send(c, notFound(action.dealCode)));
  if (e.status !== "pending" && e.status !== "approved") {
    return void (await send(c, `<code>${e.code}</code> ${e.status === "rejected" ? "رد" : "لغو"} شده است.`));
  }
  const ref = cleanRef(action.ref);
  if (!ref) return void (await send(c, BAD_REF));
  await setEntryRef(app.db, e.id, ref);
  const fresh: Entry = { ...e, ref };
  // Settlement payments share one batch card with no single owner; only a plain card is redrawn.
  if (fresh.cardMsgId !== null && !fresh.batchId) {
    try {
      await app.tg.call("editMessageText", {
        chat_id: c.chatId, message_id: fresh.cardMsgId, text: renderEntry(fresh), parse_mode: "HTML",
        reply_markup: entryKeyboard(fresh) ?? { inline_keyboard: [] },
      });
    } catch (err) {
      if (!(err instanceof TgError)) throw err;
    }
  }
  await send(c, `🔖 برای <code>${e.code}</code> ثبت شد: <code>${escapeHtml(ref)}</code>`);
}

/** Private chat: record a deposit (RECEIVE) or withdrawal (PAY) straight on a bank and show its new balance. */
async function bankMove(c: Ctx, action: Extract<Action, { kind: "payment" }>): Promise<void> {
  const { app, msg } = c;
  if (!c.banks.length || !bankable(action.trade)) return void (await send(c, PRIVATE_WRITE));
  const picked = pickBank(c, action.trade, action.bankHint);
  if (typeof picked === "string") return void (await send(c, picked));
  const { bank } = picked;
  const withRef = pickRef(picked.trade, action.ref);
  if (!withRef) return void (await send(c, BAD_REF));
  // A bank move has no reference column: the tracking code is kept in its note.
  const trade: Trade = withRef.ref
    ? { ...withRef.trade, note: [withRef.trade.note, `کد پیگیری ${withRef.ref}`].filter(Boolean).join(" · ") }
    : withRef.trade;
  if (!bank) {
    return void (await send(
      c,
      `کدام بانک؟ مثلاً «واریز ۵۰ میلیون به سامان» یا «برداشت ۲۰ میلیون از سامان».\nبانک‌ها: ${bankList(c)}\n\n${PRIVATE_WRITE}`,
    ));
  }
  const amount = bankEffect(trade);
  await addBankMove(app.db, { bankId: bank.id, amount, note: trade.note, createdBy: who(msg.from), createdAt: app.now() });
  const balance = (await bankBalances(app.db)).get(bank.id) ?? new Decimal(0);
  await send(c, renderBankMove(bank.name, amount, trade.note, balance));
}

const notFound = (code: string) => `معامله‌ی <code>${escapeHtml(code)}</code> در این گروه پیدا نشد.`;

/** KuCoin quotes priced with this message's single Nobitex fetch. */
async function quotes(c: Ctx, coins: string[]): Promise<CoinQuote[]> {
  const usdts = await Promise.all(coins.map((coin) => fetchCoinUsdt(coin, c.app.fetch)));
  return coins.map((coin, i) => {
    const usdt = usdts[i];
    return { coin, usdt, toman: usdt && c.usdt ? usdt.mul(c.usdt.latest) : null };
  });
}

/**
 * Whose account a query is about. In a group it's always this chat; in a private chat a client
 * sees only this chat, and an admin looks a client up by name. A string is the reply to send.
 */
async function resolveAccount(c: Ctx, hint: string | undefined): Promise<{ chatId: number; name: string } | string> {
  if (c.inGroup) {
    const title = ("title" in c.msg.chat && c.msg.chat.title) || "";
    return { chatId: c.chatId, name: c.account ? accountName(c.account) : title };
  }
  if (c.role === "client") return { chatId: c.chatId, name: who(c.msg.from) };
  const key = normalize(hint ?? "").trim().toLowerCase();
  const matches = (await listAccounts(c.app.db)).filter((a) =>
    normalize(accountName(a)).toLowerCase().includes(key),
  );
  if (matches.length === 1) return { chatId: matches[0].chatId, name: accountName(matches[0]) };
  if (!matches.length) return NOT_FOUND;
  const names = matches.slice(0, MAX_LISTED).map((a) => `• ${escapeHtml(accountName(a))}`);
  if (matches.length > MAX_LISTED) names.push("…");
  return ["کدام مشتری؟ دقیق‌تر بگو:", ...names].join("\n");
}

/** «How much is left»: one deal's open legs (code or replied-to card), else the account in short sentences. */
async function remaining(c: Ctx, action: Extract<Action, { kind: "remaining" }>, joke: string | undefined): Promise<void> {
  const { app } = c;
  const replied = c.msg.reply_to_message;
  let deal: Entry | null = null;
  if (action.dealCode) deal = await getByCode(app.db, c.chatId, action.dealCode);
  else if (replied) deal = await findByCardMessage(app.db, c.chatId, replied.message_id);
  if (!deal && action.dealCode) return void (await send(c, withJoke("این معامله پیدا نشد.", joke)));

  if (deal) {
    const code = `<code>${escapeHtml(deal.code)}</code>`;
    let body: string;
    if (isPayment(deal.trade)) body = `${code} یک پرداخته، نه معامله.`;
    else if (deal.status === "pending") body = `${code} هنوز تایید نشده.`;
    else if (deal.status !== "approved") body = `${code} ${deal.status === "rejected" ? "رد" : "لغو"} شده.`;
    else body = renderDealRemaining(deal.code, allocate(await approvedLedger(app.db, c.chatId)).get(deal.id) ?? []);
    return void (await send(c, withJoke(body, joke)));
  }

  const target = await resolveAccount(c, action.clientHint);
  if (typeof target === "string") return void (await send(c, withJoke(target, joke)));
  const ledger = await approvedLedger(app.db, target.chatId);
  await send(c, withJoke(renderAccountRemaining(summarize(ledger.map((l) => l.trade))), joke));
}

async function settle(c: Ctx, code: string, bankHint?: string): Promise<void> {
  const { app, msg } = c;
  // «تسویه کن به سامان»: the toman leg of the settlement lands on that bank.
  let bank: Bank | null = null;
  if (bankHint && c.banks.length) {
    bank = matchBank(c.banks, bankHint);
    if (!bank) return void (await send(c, `بانک «${escapeHtml(bankHint)}» را نمی‌شناسم. بانک‌های تعریف‌شده: ${bankList(c)}`));
  }
  const deal = await getByCode(app.db, c.chatId, code);
  if (!deal || isPayment(deal.trade)) return void (await send(c, notFound(code)));
  if (deal.status !== "approved") {
    return void (await send(c, `معامله‌ی <code>${deal.code}</code> تایید شده نیست؛ اول باید تایید شود.`));
  }
  const legs = (allocate(await approvedLedger(app.db, c.chatId)).get(deal.id) ?? []).filter((l) =>
    l.remaining.gt(0),
  );
  if (!legs.length) return void (await send(c, `معامله‌ی <code>${deal.code}</code> باز نیست؛ قبلاً تسویه شده است.`));

  const payments: Entry[] = [];
  for (const leg of legs) {
    const trade: Trade = {
      side: leg.dir === "client_owes" ? "RECEIVE" : "PAY",
      amount: leg.remaining,
      asset: leg.asset,
      rate: null,
      note: `تسویه ${deal.code}`,
      tomanTotal: null,
    };
    payments.push(
      await createEntry(app.db, {
        chatId: c.chatId,
        trade,
        bankId: bank && bankable(trade) ? bank.id : null,
        linkedDealId: deal.id,
        sourceMsgId: msg.message_id,
        createdBy: who(msg.from),
        createdById: msg.from?.id ?? 0,
        createdAt: app.now(),
      }),
    );
  }
  const ids = payments.map((p) => p.id);
  await setBatch(app.db, ids, String(ids[0]));
  await sendCard(c, ids, renderSettlement(deal, payments), settlementKeyboard(ids[0]));
}

async function edit(
  c: Ctx,
  action: Extract<Action, { kind: "edit" }>,
  out: NluOutput | null,
  joke: string | undefined,
): Promise<void> {
  const { app, msg } = c;
  const deal = await getByCode(app.db, c.chatId, action.dealCode);
  if (!deal) return void (await send(c, notFound(action.dealCode)));
  if (deal.status !== "pending" && deal.status !== "approved") {
    return void (await send(c, `<code>${deal.code}</code> ${deal.status === "rejected" ? "رد" : "لغو"} شده و قابل ویرایش نیست.`));
  }
  const cur = deal.trade;
  const ch = action.changes;
  if (ch.rate !== undefined && isPayment(cur)) {
    return void (await send(c, "پرداخت قیمت ندارد؛ فقط مبلغ یا توضیح را می‌شود تغییر داد."));
  }

  // R13: intent.ts expanded «۲۷۰» with the default asset; redo it with this deal's asset.
  let rate = ch.rate;
  if (rate !== undefined) {
    const raw = out?.changes?.rate_text !== undefined ? parseAmountText(out.changes.rate_text) : null;
    rate = expandRateShorthand(raw ?? rate, cur.asset, c.usdt?.latest ?? null);
  }

  const changes: EditChanges = {};
  if (ch.amount !== undefined) changes.amount = ch.amount;
  if (rate !== undefined) changes.rate = rate;
  if (ch.note !== undefined) changes.note = ch.note;
  // The preview is against today's trade; approval re-applies the same changes to the trade as it is then.
  const next = applyTradeEdit(cur, changes);

  const id = await createPendingAction(app.db, {
    chatId: c.chatId,
    kind: "edit",
    entryId: deal.id,
    payload: editPayload(changes),
    createdBy: msg.from?.id ?? 0,
    createdAt: app.now(),
  });
  await send(c, renderEditProposal(deal, next, id), editKeyboard(id));
}
