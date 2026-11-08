/** Task 8: natural-language and `#` message handling: cards, answers, refusals. */
import Decimal from "decimal.js";
import type { Message, User } from "@grammyjs/types";
import type { App } from "../app";
import {
  entryKeyboard, escapeHtml, editKeyboard, type Keyboard, renderBalance, renderEditProposal,
  renderEntry, renderList, renderPrices, renderSettlement, settlementKeyboard,
} from "../cards";
import {
  type Account, accountName, approvedLedger, createEntry, createPendingAction, type EditChanges, editPayload,
  type Entry, findByCardMessage, getAccount, getByCode, getSetting, isAdmin, listAccounts, recent, setBatch,
  setCardMessage,
} from "../db";
import {
  type Action, DEFAULT_DEVIATION_PCT, deviationPct, expandRateShorthand, parseDeviationSetting, toAction,
} from "../intent";
import { BUSY_TEXT, CLIENT_WRITE_REFUSALS, ORDINARY_LINES, pick } from "../jokes";
import { allocate, openDeals, summarize } from "../ledger";
import { normalize, parseAmountText } from "../money";
import type { NluInput, NluOutput } from "../nlu";
import { applyTradeEdit, parseMessage, TradeError } from "../parser";
import { type CoinQuote, fetchCoinUsdt, fetchUsdtToman, type UsdtPrice } from "../prices";
import { isPayment, type Trade } from "../trade";

const EMPTY_HINT =
  "جانم؟ 🙂 بگو چه کاری انجام بدهم؛ مثلاً «حساب ما چقدر است؟» یا «قیمت تتر».\n" +
  "ثبت معامله با # هم کار می‌کند: <code>#خرید ۱۰۰۰ تتر ۲۶۴۰۰۰</code>";
const PRIVATE_WRITE =
  "ثبت و تغییر معامله فقط در گروه همان مشتری انجام می‌شود (یا در مینی‌اپ). همان‌جا بنویسید 🙂";
const NOT_FOUND = "پیدا نشد.";

const DEAL_INTENTS = new Set<NluOutput["intent"]>(["settle_deal", "edit_deal", "cancel_deal"]);
const WRITE_KINDS = new Set<Action["kind"]>(["create", "payment", "settle", "edit", "cancel"]);
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
}

const who = (u: User | undefined): string =>
  !u ? "?" : u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ");

async function send(c: Pick<Ctx, "app" | "msg" | "chatId">, text: string, keyboard?: Keyboard | null): Promise<number> {
  const res = await c.app.tg.call<{ message_id: number }>("sendMessage", {
    chat_id: c.chatId,
    text,
    parse_mode: "HTML",
    reply_parameters: { message_id: c.msg.message_id },
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

  const [usdt, account, devSetting] = await Promise.all([
    fetchUsdtToman(app.fetch),
    inGroup ? getAccount(app.db, msg.chat.id) : Promise.resolve(null),
    getSetting(app.db, "deviation_pct"),
  ]);
  const c: Ctx = {
    ...c0,
    usdt,
    account,
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
      if (c.humor) {
        const d = deviation(c, trade);
        let teased: string | undefined;
        if (d && d.dev.abs().gt(c.alertPct)) {
          teased = (await app.nlu.understand(await nluInput(c, text)))?.joke?.trim() || undefined;
        }
        joke = teased ?? pick(ORDINARY_LINES, msg.message_id);
      }
    }
  }

  // 2. Natural language (or a `#` message that didn't parse).
  if (!action) {
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
    joke = c.humor ? out.joke?.trim() || undefined : undefined;
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
      const e = await createEntry(app.db, {
        chatId: c.chatId,
        trade: action.trade,
        rawText: text,
        joke: joke ?? null,
        sourceMsgId: msg.message_id,
        createdBy: who(msg.from),
        createdById: msg.from?.id ?? 0,
        createdAt: app.now(),
      });
      const d = deviation(c, e.trade);
      const card = renderEntry(e, { ref: d?.ref ?? null, deviationPct: d?.dev ?? null, alertPct: c.alertPct });
      await setCardMessage(app.db, e.id, await send(c, card, entryKeyboard(e)));
      return;
    }
    case "settle":
      return settle(c, action.dealCode);
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
    case "balance":
    case "deals": {
      const target = await resolveAccount(c, action.clientHint);
      if (typeof target === "string") return void (await send(c, withJoke(target, joke)));
      let body: string;
      if (action.kind === "balance") {
        const ledger = await approvedLedger(app.db, target.chatId);
        body = renderBalance(target.name, summarize(ledger.map((l) => l.trade)), openDeals(ledger));
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

async function settle(c: Ctx, code: string): Promise<void> {
  const { app, msg } = c;
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
    payments.push(
      await createEntry(app.db, {
        chatId: c.chatId,
        trade: {
          side: leg.dir === "client_owes" ? "RECEIVE" : "PAY",
          amount: leg.remaining,
          asset: leg.asset,
          rate: null,
          note: `تسویه ${deal.code}`,
          tomanTotal: null,
        },
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
  await send(c, renderSettlement(deal, payments), settlementKeyboard(ids[0]));
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
  await send(c, withJoke(renderEditProposal(deal, next, id), joke), editKeyboard(id));
}
