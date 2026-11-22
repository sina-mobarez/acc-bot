/** Persian rendering (Telegram HTML): cards, keyboards, lists, balances, prices. Layout follows the v1 Python cards (see git history). */
import Decimal from "decimal.js";
import { explorerUrl } from "./chain";
import { dealCode, type Entry, type Status, type TxMeta, type TxScan } from "./db";
import type { Account, Leg } from "./ledger";
import { debts } from "./ledger";
import { assetName, fa, faAmount, TOMAN } from "./money";
import type { CoinQuote, UsdtPrice } from "./prices";
import { byToman, isPayment, type Side, type Trade, tradeTotal } from "./trade";
import { networkName } from "./txscan";

export const LINE = "━━━━━━━━━━━━━━━━━━";

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const STATUS: Record<Status, [string, string]> = {
  pending: ["⏳", "در انتظار تایید"],
  approved: ["✅", "تایید شد"],
  rejected: ["❌", "رد شد"],
  cancelled: ["🚫", "لغو شد"],
};
const SIDE: Record<Side, [string, string]> = {
  BUY: ["🟢", "خرید"],
  SELL: ["🔴", "فروش"],
  PAY: ["💸", "پرداخت"],
  RECEIVE: ["📥", "دریافت"],
};
const DIRECTION: Record<string, string> = { PAY: "از ما به مشتری", RECEIVE: "از مشتری به ما" };

const JALALI = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
  timeZone: "Asia/Tehran",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function jalaliParts(iso: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of JALALI.formatToParts(new Date(iso))) out[p.type] = p.value;
  return out;
}

/** '2026-10-17T19:05:00+03:30' -> '۱۴۰۵/۰۷/۲۵ – ۱۹:۰۵' */
export function jalali(iso: string): string {
  const p = jalaliParts(iso);
  return fa(`${p.year}/${p.month}/${p.day} – ${p.hour}:${p.minute}`);
}

export function jalaliDate(iso: string): string {
  const p = jalaliParts(iso);
  return fa(`${p.year}/${p.month}/${p.day}`);
}

/** A toman figure (a price, a total, a bank balance): no decimals. */
const money = (v: Decimal): string => faAmount(v, TOMAN);

export interface EntryOpts {
  error?: string;
  confirmCancel?: boolean;
}

/** The typed-in reference of an entry: a tracking code for toman and deals, a hash for crypto payments. */
function refLine(e: Pick<Entry, "trade" | "ref">): string | null {
  if (!e.ref) return null;
  const label = isPayment(e.trade) && e.trade.asset !== TOMAN ? "🔎 <b>هش:</b>" : "🔖 <b>کد پیگیری:</b>";
  return `${label} <code>${escapeHtml(e.ref)}</code>`;
}

/**
 * A deal or payment card: what it is, its numbers and its status, nothing else. Who recorded or
 * approved it and when stay in D1 (and the Mini App), not on the card.
 */
export function renderEntry(e: Entry, o: EntryOpts = {}): string {
  const t = e.trade;
  const [icon, side] = SIDE[t.side];
  const name = escapeHtml(assetName(t.asset));
  const total = tradeTotal(t);
  const lines = [`${icon} <b>${side} ${faAmount(t.amount, t.asset)} ${name}</b> · <code>${e.code}</code>`];

  if (!isPayment(t) && t.rate !== null && total) {
    lines.push(`💵 <b>قیمت:</b> ${money(t.rate)} · <b>جمع:</b> ${money(total)} تومان`);
  }
  if (e.bank) lines.push(`🏦 <b>بانک:</b> ${escapeHtml(e.bank.name)}`);
  const ref = refLine(e);
  if (ref) lines.push(ref);
  if (e.tx) lines.push(...txLines(e.tx));
  if (isPayment(t) && e.linkedDealId !== null) lines.push(`🔗 <b>معامله:</b> <code>${dealCode(e.linkedDealId)}</code>`);
  if (t.note) lines.push(`📝 ${escapeHtml(t.note)}`);
  for (const w of e.tx?.warnings ?? []) lines.push(`⚠️ ${escapeHtml(w)}`);

  const [statusIcon, status] = STATUS[e.status];
  lines.push(`${statusIcon} <b>${status}</b>`);
  if (o.confirmCancel) lines.push("", "⚠️ <b>این مورد تایید شده است. مطمئن هستید که لغو شود؟</b>");
  if (o.error) lines.push("", `⚠️ ${escapeHtml(o.error)}`);
  return lines.join("\n");
}

/** What a payment's reference is called: a tracking code for toman, a transaction hash for anything else. */
export const refName = (t: Trade): string => (t.asset === TOMAN ? "کد پیگیری" : "هش تراکنش");

/** A payment that is complete except for its reference: nothing is saved until an admin replies with it. */
export function renderRefAsk(t: Trade, bank: string | null): string {
  const [icon, side] = SIDE[t.side];
  const head = `${icon} <b>${side} ${faAmount(t.amount, t.asset)} ${escapeHtml(assetName(t.asset))}</b>` + (bank ? ` · 🏦 ${escapeHtml(bank)}` : "");
  return `${head}\n🔖 <b>${refName(t)}</b> را در ریپلای همین پیام بفرست تا ثبت شود. بدون آن ثبت نمی‌شود.`;
}

const short = (s: string): string => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

/** A scanned transaction in one line: network and explorer link, plus a second line while it isn't final. */
function txLines(m: TxMeta): string[] {
  const url = escapeHtml(explorerUrl(m.network, m.hash)).replace(/"/g, "&quot;");
  const lines = [`🔎 <b>${escapeHtml(networkName(m.network))}:</b> <a href="${url}">${escapeHtml(short(m.hash))}</a>`];
  if (!m.final) lines.push(`⏳ هنوز قطعی نیست (${fa(m.confirmations)} تأیید)`);
  return lines;
}

/** A scanned transfer waiting for an admin to pick its deal. */
export function renderTxScan(s: TxScan, note?: string): string {
  const [icon, side] = SIDE[s.side];
  const lines = [`${icon} <b>${side} ${faAmount(s.amount, "USDT")} ${escapeHtml(assetName("USDT"))}</b>`, ...txLines(s.meta)];
  for (const w of s.meta.warnings) lines.push(`⚠️ ${escapeHtml(w)}`);
  if (note) lines.push("", `ℹ️ ${escapeHtml(note)}`);
  lines.push("<b>برای کدام معامله؟</b> (فقط مدیر)");
  return lines.join("\n");
}

export const MAX_PICKER_DEALS = 8;

/** One button per open deal (oldest first, at most 8), then "no deal". */
export function txPickerKeyboard(scanId: number, deals: { id: number; code: string; remaining: Decimal }[]): Keyboard {
  const rows = deals
    .slice(0, MAX_PICKER_DEALS)
    .map((d) => [btn(`${d.code} · ${faAmount(d.remaining, "USDT")} تتر`, `tp:${scanId}:${d.id}`)]);
  rows.push([btn("بدون معامله", `tp:${scanId}:0`)]);
  return { inline_keyboard: rows };
}

export type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
const btn = (text: string, callback_data: string) => ({ text, callback_data });

export function entryKeyboard(e: Entry, confirmCancel = false): Keyboard | null {
  if (e.status === "pending") {
    return {
      inline_keyboard: [
        [btn("✅ تایید", `ok:${e.id}`), btn("❌ رد", `no:${e.id}`)],
        [btn("🚫 لغو", `cx:${e.id}`)],
      ],
    };
  }
  if (e.status === "approved") {
    if (confirmCancel) {
      return { inline_keyboard: [[btn("⚠️ بله، لغو شود", `cy:${e.id}`), btn("↩️ بازگشت", `cn:${e.id}`)]] };
    }
    const label = isPayment(e.trade) ? "🚫 لغو پرداخت" : "🚫 لغو معامله";
    return { inline_keyboard: [[btn(label, `cx:${e.id}`)]] };
  }
  return null;
}

function tradeLine(t: Trade, direction = true): string {
  const [icon, side] = SIDE[t.side];
  let line = `${icon} ${side} ${faAmount(t.amount, t.asset)} ${escapeHtml(assetName(t.asset))}`;
  const total = tradeTotal(t);
  if (isPayment(t)) line += direction ? ` (${DIRECTION[t.side]})` : "";
  else if (t.rate !== null && total) line += ` × ${money(t.rate)} = <b>${money(total)}</b> تومان`;
  return line;
}

/** A deal together with the payments recorded alongside it, as one short card for one decision. */
export function renderSettlement(deal: Entry, payments: Entry[]): string {
  // The batch is decided as one: its status is the payments' status, not the (already approved) deal's.
  const [statusIcon, status] = STATUS[(payments[0] ?? deal).status];
  const lines = [`🧾 <b>تسویه</b> · <code>${deal.code}</code>`, tradeLine(deal.trade)];
  for (const p of payments) {
    lines.push(tradeLine(p.trade, false) + (p.bank ? ` · 🏦 ${escapeHtml(p.bank.name)}` : ""));
  }
  lines.push(`${statusIcon} <b>${status}</b>`);
  return lines.join("\n");
}

/** Buttons act on the batch through its first entry id. */
export function settlementKeyboard(batchId: number | string): Keyboard {
  return { inline_keyboard: [[btn("✅ تایید", `ok:${batchId}`), btn("❌ رد", `no:${batchId}`)]] };
}

function describeTrade(t: Trade): string {
  const total = tradeTotal(t);
  const parts = [`${faAmount(t.amount, t.asset)} ${escapeHtml(assetName(t.asset))}`];
  if (t.rate !== null) parts.push(`× ${money(t.rate)}`);
  if (total && !isPayment(t)) parts.push(`= ${money(total)} تومان`);
  if (t.note) parts.push(`· ${escapeHtml(t.note)}`);
  return `${SIDE[t.side][0]} ${SIDE[t.side][1]} ${parts.join(" ")}`;
}

export function renderEditProposal(e: Entry, next: Trade, _actionId: number | string): string {
  return [
    `✏️ <b>ویرایش</b> · <code>${e.code}</code>`,
    `<b>قبل:</b> ${describeTrade(e.trade)}`,
    `<b>بعد:</b> ${describeTrade(next)}`,
  ].join("\n");
}

/** The outcome of an applied edit: the real before and after (the entry's own card is updated separately). */
export function renderEditApplied(updated: Entry, before: Trade): string {
  return [
    `✅ <b>ویرایش شد</b> · <code>${updated.code}</code>`,
    `<b>قبل:</b> ${describeTrade(before)}`,
    `<b>بعد:</b> ${describeTrade(updated.trade)}`,
  ].join("\n");
}

export function editKeyboard(actionId: number | string): Keyboard {
  return { inline_keyboard: [[btn("✅ اعمال", `ea:${actionId}`), btn("🗑 انصراف", `ed:${actionId}`)]] };
}

export function renderList(name: string, entries: Entry[]): string {
  const n = escapeHtml(name);
  if (!entries.length) return `📋 هنوز معامله یا پرداختی با «${n}» ثبت نشده است.`;
  const lines = [`📋 <b>معاملات و پرداخت‌ها با «${n}»</b>`, `<i>${fa(entries.length)} مورد آخر</i>`, LINE];
  for (const e of entries) {
    lines.push(`${STATUS[e.status][0]} <code>${e.code}</code> · ${jalaliDate(e.createdAt)}\n${tradeLine(e.trade)}`);
  }
  lines.push(LINE, "⏳ در انتظار · ✅ تایید · ❌ رد · 🚫 لغو", "تراز حساب: /balance");
  return lines.join("\n");
}

export function debtLine(asset: string, owed: Decimal): string {
  const name = escapeHtml(assetName(asset));
  if (owed.isZero()) return `✅ ${name}: تسویه`;
  if (owed.gt(0)) return `🔴 ${name}: مشتری <b>${faAmount(owed, asset)}</b> ${name} به ما بدهکار است`;
  return `🔵 ${name}: ما <b>${faAmount(owed.neg(), asset)}</b> ${name} به مشتری بدهکاریم`;
}

/** One-line "how much is left" sentence; toman owed by the client reads «واریز کنه». */
function remainingLine(prefix: string, clientOwes: boolean, asset: string, amount: Decimal): string {
  const amt = `<b>${faAmount(amount, asset)} ${escapeHtml(assetName(asset))}</b>`;
  if (!clientOwes) return `${prefix}ما باید ${amt} دیگه ${prefix ? "به مشتری " : ""}بدیم.`;
  return `${prefix}مشتری باید ${amt} دیگه ${asset === TOMAN ? "واریز کنه" : "بده"}.`;
}

/** What is still open on one deal, one short line per leg; settled when none. */
export function renderDealRemaining(code: string, legs: Leg[]): string {
  const c = escapeHtml(code);
  const open = legs.filter((l) => l.remaining.gt(0));
  if (!open.length) return `<code>${c}</code> تسویه‌ست ✅`;
  return open
    .map((l) => remainingLine(`برای تسویه‌ی <code>${c}</code>، `, l.dir === "client_owes", l.asset, l.remaining))
    .join("\n");
}

/** What is still open on the whole account, one short line per asset. */
export function renderAccountRemaining(acc: Account): string {
  const lines = debts(acc)
    .filter(([, owed]) => !owed.isZero())
    .map(([asset, owed]) => remainingLine("", owed.gt(0), asset, owed.abs()));
  return lines.length ? lines.join("\n") : "حساب کاملاً تسویه‌ست ✅";
}

/** Lines per list in one message: keeps balance/reminder texts under Telegram's 4096-char limit. */
export const MAX_LIST_LINES = 15;

function openDealLines(open: { id: number; legs: Leg[] }[]): string[] {
  const lines: string[] = [];
  for (const d of open.slice(0, MAX_LIST_LINES)) {
    const legs = d.legs
      .filter((l) => l.remaining.gt(0))
      .map((l) => {
        const nm = escapeHtml(assetName(l.asset));
        const who = l.dir === "client_owes" ? "مشتری" : "ما";
        return `${who}: ${faAmount(l.remaining, l.asset)} از ${faAmount(l.total, l.asset)} ${nm}`;
      });
    lines.push(`📌 <code>${dealCode(d.id)}</code> · ${legs.join(" · ")}`);
  }
  if (open.length > MAX_LIST_LINES) lines.push(`<i>… و ${fa(open.length - MAX_LIST_LINES)} مورد دیگر</i>`);
  return lines;
}

const BALANCE_ICON = new Map<string, string>([["IRT", "🇮🇷"], ["USDT", "💵"]]);

/**
 * The owner's simple balance card: one line per currency, signed from the client's side
 * (minus = بدهکار, client owes us; plus = بستانکار, we owe them; zero = تسویه شده).
 * IRT and USDT always show; other currencies only once touched.
 */
export function renderBalance(name: string, acc: Account): string {
  const n = escapeHtml(name);
  if (!acc.count) return `💼 هنوز معامله یا پرداخت تایید شده‌ای با «${n}» وجود ندارد.`;
  const owed = new Map(debts(acc));
  const others = [...owed.keys()].filter((a) => a !== TOMAN && a !== "USDT").sort();
  const lines = [`💼 <b>حساب «${n}»</b>`, LINE];
  for (const asset of [TOMAN, "USDT", ...others]) {
    const v = owed.get(asset) ?? new Decimal(0);
    const client = v.neg(); // client's view: what they owe is negative
    const label = v.isZero() ? "✅ تسویه شده" : v.gt(0) ? "🔴 بدهکار" : "🟢 بستانکار";
    const icon = BALANCE_ICON.get(asset) ?? "🪙";
    lines.push(`${icon} <b>${escapeHtml(asset)}</b>   <code>${faAmount(client, asset)}</code>  /  ${label}`);
  }
  if (acc.unpriced) lines.push(`<i>⚠️ ${fa(acc.unpriced)} معامله بدون قیمت در مانده تومانی حساب نشده است.</i>`);
  return lines.join("\n");
}

/** Nudge to a client: what they owe, what we owe (if anything), then open deals. */
export function renderReminder(
  name: string,
  acc: Account,
  open: { id: number; legs: Leg[] }[],
  nudge: string,
): string {
  const lines = [`🔔 <b>یادآوری حساب «${escapeHtml(name)}»</b>`, `<i>${escapeHtml(nudge)}</i>`, LINE];
  const d = debts(acc);
  const clientOwes = d.filter(([, v]) => v.gt(0));
  const weOwe = d.filter(([, v]) => v.lt(0));
  for (const [asset, v] of clientOwes) {
    lines.push(`🔴 شما <b>${faAmount(v, asset)}</b> ${escapeHtml(assetName(asset))} به ما بدهکارید`);
  }
  for (const [asset, v] of weOwe) {
    lines.push(`🔵 ما هم <b>${faAmount(v.neg(), asset)}</b> ${escapeHtml(assetName(asset))} به شما بدهکاریم`);
  }
  if (!clientOwes.length && !weOwe.length) lines.push("✅ حساب کاملاً تسویه است.");
  if (open.length) lines.push(LINE, "📂 <b>معاملات باز</b>", ...openDealLines(open));
  return lines.join("\n");
}

/** Our own bank balances. Admins only, and never in a group. */
export function renderBanks(banks: { name: string; balance: Decimal }[]): string {
  if (!banks.length) return "🏦 هنوز بانکی تعریف نشده است. از پنل مدیریت، بخش «بانک‌ها» اضافه کنید.";
  const lines = ["🏦 <b>موجودی بانک‌ها</b>", LINE];
  let total = new Decimal(0);
  for (const b of banks) {
    total = total.plus(b.balance);
    lines.push(`🏦 ${escapeHtml(b.name)}: <b>${money(b.balance)}</b> تومان`);
  }
  if (banks.length > 1) lines.push(LINE, `💰 <b>جمع:</b> ${money(total)} تومان`);
  return lines.join("\n");
}

/** A deposit or withdrawal recorded straight on a bank (private chat), with the new balance. */
export function renderBankMove(bank: string, amount: Decimal, note: string, balance: Decimal): string {
  const lines = [
    amount.gte(0) ? `📥 <b>واریز ${money(amount)} تومان</b>` : `💸 <b>برداشت ${money(amount.neg())} تومان</b>`,
    `🏦 <b>بانک:</b> ${escapeHtml(bank)}`,
  ];
  if (note) lines.push(`📝 <b>توضیحات:</b> ${escapeHtml(note)}`);
  lines.push(LINE, `💰 <b>موجودی:</b> ${money(balance)} تومان`, "✅ ثبت شد");
  return lines.join("\n");
}

export function renderPrices(usdt: UsdtPrice | null, quotes: CoinQuote[]): string {
  const lines = ["📈 <b>قیمت‌های لحظه‌ای</b>", LINE];
  if (usdt) {
    lines.push(
      `💵 <b>تتر (نوبیتکس)</b>`,
      `آخرین: ${money(usdt.latest)} ${assetName(TOMAN)}`,
      `بهترین خرید: ${money(usdt.bestBuy)} · بهترین فروش: ${money(usdt.bestSell)}`,
    );
  } else {
    lines.push("💵 قیمت تتر الان در دسترس نیست.");
  }
  for (const q of quotes) {
    const c = escapeHtml(q.coin);
    if (q.usdt === null) lines.push(`🪙 ${c}: قیمت در دسترس نیست`);
    else lines.push(`🪙 ${c}: ${fa(q.usdt)} تتر` + (q.toman ? ` ≈ ${money(q.toman.toDecimalPlaces(0))} تومان` : ""));
  }
  return lines.join("\n");
}
