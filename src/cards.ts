/** Persian rendering (Telegram HTML): cards, keyboards, lists, balances, prices. Mirrors v1 accbot/card.py. */
import Decimal from "decimal.js";
import { dealCode, type Entry, type Status } from "./db";
import type { Account, Leg } from "./ledger";
import { debts } from "./ledger";
import { assetName, fa, TOMAN } from "./money";
import type { CoinQuote, UsdtPrice } from "./prices";
import { byToman, isPayment, type Side, type Trade, tradeTotal } from "./trade";

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

const money = (v: Decimal): string => fa(v);
const pct = (v: Decimal): string => fa(v.abs().toDecimalPlaces(1));

export interface EntryOpts {
  error?: string;
  confirmCancel?: boolean;
  ref?: Decimal | null;
  deviationPct?: Decimal | null;
  alertPct?: Decimal;
}

export function renderEntry(e: Entry, o: EntryOpts = {}): string {
  const t = e.trade;
  const [icon, side] = SIDE[t.side];
  const name = escapeHtml(assetName(t.asset));
  const total = tradeTotal(t);
  const lines = [`${icon} <b>${side} ${fa(t.amount)} ${name}</b>`, `🆔 <code>${e.code}</code>`, LINE];

  if (isPayment(t)) {
    lines.push(`↔️ <b>جهت:</b> ${DIRECTION[t.side]}`);
    lines.push(`💰 <b>مبلغ:</b> ${fa(t.amount)} ${name}`);
  } else if (byToman(t) && total && t.rate) {
    lines.push(`🧾 <b>مبلغ تومانی:</b> ${money(total)} تومان`);
    lines.push(`💵 <b>قیمت واحد:</b> ${money(t.rate)} تومان`);
    lines.push(`💰 <b>مقدار ${name}:</b> ${fa(t.amount)} ${name}`);
    lines.push(`<i>   (= ${money(total)} ÷ ${money(t.rate)})</i>`);
  } else {
    lines.push(`💰 <b>مقدار:</b> ${fa(t.amount)} ${name}`);
  }
  if (t.rate !== null && !byToman(t) && total) {
    lines.push(`💵 <b>قیمت واحد:</b> ${money(t.rate)} تومان`);
    lines.push(`🧾 <b>مبلغ کل:</b> ${money(total)} تومان`);
  }
  if (o.ref && t.rate !== null && !isPayment(t)) {
    const dev = o.deviationPct;
    const alert = dev && dev.abs().gt(o.alertPct ?? new Decimal(3));
    let l = `📊 <b>قیمت نوبیتکس:</b> ${money(o.ref)} تومان`;
    if (dev) l += ` (${dev.isNegative() ? "−" : "+"}${pct(dev)}٪)`;
    if (alert) l += " ⚠️";
    lines.push(l);
  }
  if (t.note) lines.push(`📝 <b>توضیحات:</b> ${escapeHtml(t.note)}`);

  const [statusIcon, status] = STATUS[e.status];
  lines.push(LINE, `🕒 ${jalali(e.createdAt)}`, `✍️ ثبت توسط ${escapeHtml(e.createdBy)}`);
  if (e.joke) lines.push("", `<i>${escapeHtml(e.joke)}</i>`);
  lines.push("", `${statusIcon} <b>وضعیت: ${status}</b>`);
  if (e.status !== "pending" && e.decidedBy && e.decidedAt) {
    const verb = e.status === "rejected" ? "رد" : "تایید";
    lines.push(`<i>${verb} توسط ${escapeHtml(e.decidedBy)} · ${jalali(e.decidedAt)}</i>`);
  }
  if (e.status === "cancelled" && e.cancelledBy && e.cancelledAt) {
    lines.push(`<i>لغو توسط ${escapeHtml(e.cancelledBy)} · ${jalali(e.cancelledAt)}</i>`);
  }
  if (o.confirmCancel) lines.push("", "⚠️ <b>این مورد تایید شده است. مطمئن هستید که لغو شود؟</b>");
  if (o.error) lines.push("", `⚠️ ${escapeHtml(o.error)}`);
  return lines.join("\n");
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

function tradeLine(t: Trade): string {
  const [icon, side] = SIDE[t.side];
  let line = `${icon} ${side} ${fa(t.amount)} ${escapeHtml(assetName(t.asset))}`;
  const total = tradeTotal(t);
  if (isPayment(t)) line += ` (${DIRECTION[t.side]})`;
  else if (t.rate !== null && total) line += ` × ${money(t.rate)} = <b>${money(total)}</b> تومان`;
  return line;
}

/** A deal together with the payments recorded alongside it, as one card for one decision. */
export function renderSettlement(deal: Entry, payments: Entry[]): string {
  // The batch is decided as one: its status is the payments' status, not the (already approved) deal's.
  const head = payments[0] ?? deal;
  const [statusIcon, status] = STATUS[head.status];
  const lines = [
    `🧾 <b>معامله و تسویه</b>`,
    `🆔 <code>${deal.code}</code>`,
    LINE,
    tradeLine(deal.trade),
  ];
  if (deal.trade.note) lines.push(`📝 ${escapeHtml(deal.trade.note)}`);
  lines.push(LINE, "💳 <b>پرداخت‌ها</b>");
  for (const p of payments) lines.push(tradeLine(p.trade));
  lines.push(LINE, `🕒 ${jalali(deal.createdAt)}`, `✍️ ثبت توسط ${escapeHtml(deal.createdBy)}`);
  if (deal.joke) lines.push("", `<i>${escapeHtml(deal.joke)}</i>`);
  lines.push("", `${statusIcon} <b>وضعیت: ${status}</b>`);
  if (head.status !== "pending" && head.decidedBy && head.decidedAt) {
    const verb = head.status === "rejected" ? "رد" : "تایید";
    lines.push(`<i>${verb} توسط ${escapeHtml(head.decidedBy)} · ${jalali(head.decidedAt)}</i>`);
  }
  return lines.join("\n");
}

/** Buttons act on the batch through its first entry id. */
export function settlementKeyboard(batchId: number | string): Keyboard {
  return { inline_keyboard: [[btn("✅ تایید", `ok:${batchId}`), btn("❌ رد", `no:${batchId}`)]] };
}

function describeTrade(t: Trade): string {
  const total = tradeTotal(t);
  const parts = [`${fa(t.amount)} ${escapeHtml(assetName(t.asset))}`];
  if (t.rate !== null) parts.push(`× ${money(t.rate)}`);
  if (total && !isPayment(t)) parts.push(`= ${money(total)} تومان`);
  if (t.note) parts.push(`· ${escapeHtml(t.note)}`);
  return `${SIDE[t.side][0]} ${SIDE[t.side][1]} ${parts.join(" ")}`;
}

export function renderEditProposal(e: Entry, next: Trade, _actionId: number | string): string {
  return [
    `✏️ <b>پیشنهاد ویرایش</b> <code>${e.code}</code>`,
    LINE,
    `<b>قبل:</b>`,
    describeTrade(e.trade),
    "",
    `<b>بعد:</b>`,
    describeTrade(next),
    LINE,
    "اعمال شود؟",
  ].join("\n");
}

/** The outcome of an applied edit: the real before/after, then the updated card. */
export function renderEditApplied(updated: Entry, before: Trade): string {
  return [
    `✅ <b>ویرایش اعمال شد</b> <code>${updated.code}</code>`,
    LINE,
    `<b>قبل:</b>`,
    describeTrade(before),
    "",
    `<b>بعد:</b>`,
    describeTrade(updated.trade),
    LINE,
    "",
    renderEntry(updated),
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
  if (owed.gt(0)) return `🔴 ${name}: مشتری <b>${fa(owed)}</b> ${name} به ما بدهکار است`;
  return `🔵 ${name}: ما <b>${fa(owed.neg())}</b> ${name} به مشتری بدهکاریم`;
}

function openDealLines(open: { id: number; legs: Leg[] }[]): string[] {
  const lines: string[] = [];
  for (const d of open) {
    const legs = d.legs
      .filter((l) => l.remaining.gt(0))
      .map((l) => {
        const nm = escapeHtml(assetName(l.asset));
        const who = l.dir === "client_owes" ? "مشتری" : "ما";
        return `${who}: ${fa(l.remaining)} از ${fa(l.total)} ${nm}`;
      });
    lines.push(`📌 <code>${dealCode(d.id)}</code> · ${legs.join(" · ")}`);
  }
  return lines;
}

export function renderBalance(name: string, acc: Account, open: { id: number; legs: Leg[] }[]): string {
  const n = escapeHtml(name);
  if (!acc.count) return `💼 هنوز معامله یا پرداخت تایید شده‌ای با «${n}» وجود ندارد.`;
  const lines = [
    `💼 <b>حساب با «${n}»</b>`,
    "<i>بر اساس معاملات و پرداخت‌های تایید شده</i>",
    LINE,
    "🧮 <b>مانده حساب</b>",
  ];
  const d = debts(acc);
  if (d.every(([, owed]) => owed.isZero())) lines.push("✅ حساب کاملاً تسویه است.");
  else lines.push(...d.map(([asset, owed]) => debtLine(asset, owed)));
  if (acc.unpriced) lines.push(`<i>⚠️ ${fa(acc.unpriced)} معامله بدون قیمت در مانده تومانی حساب نشده است.</i>`);

  if (open.length) lines.push(LINE, "📂 <b>معاملات باز</b>", ...openDealLines(open));

  for (const b of acc.trades) {
    const nm = escapeHtml(assetName(b.asset));
    lines.push(LINE, `📊 <b>معاملات ${nm}</b> · ${fa(b.count)} مورد`);
    lines.push(`🟢 خرید: ${fa(b.bought)} ${nm}` + (b.buyToman.isZero() ? "" : ` — ${money(b.buyToman)} تومان`));
    if (b.avgBuy) lines.push(`     میانگین خرید: ${money(b.avgBuy.toDecimalPlaces(0))} تومان`);
    lines.push(`🔴 فروش: ${fa(b.sold)} ${nm}` + (b.sellToman.isZero() ? "" : ` — ${money(b.sellToman)} تومان`));
    if (b.avgSell) lines.push(`     میانگین فروش: ${money(b.avgSell.toDecimalPlaces(0))} تومان`);
  }

  if (acc.paid.size || acc.received.size) {
    lines.push(LINE, "💳 <b>پرداخت‌ها</b>");
    for (const [asset, amt] of [...acc.received].sort()) {
      lines.push(`📥 دریافتی از مشتری: ${fa(amt)} ${escapeHtml(assetName(asset))}`);
    }
    for (const [asset, amt] of [...acc.paid].sort()) {
      lines.push(`💸 پرداختی به مشتری: ${fa(amt)} ${escapeHtml(assetName(asset))}`);
    }
  }
  lines.push(LINE, "<i>ثبت پرداخت: «دریافت ۵۰ میلیون تومن» یا «پرداخت ۱۰۰ تتر»</i>");
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
    lines.push(`🔴 شما <b>${fa(v)}</b> ${escapeHtml(assetName(asset))} به ما بدهکارید`);
  }
  for (const [asset, v] of weOwe) {
    lines.push(`🔵 ما هم <b>${fa(v.neg())}</b> ${escapeHtml(assetName(asset))} به شما بدهکاریم`);
  }
  if (!clientOwes.length && !weOwe.length) lines.push("✅ حساب کاملاً تسویه است.");
  if (open.length) lines.push(LINE, "📂 <b>معاملات باز</b>", ...openDealLines(open));
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
