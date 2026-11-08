"""Persian rendering (Telegram HTML): deal card, deal list and balance."""

from datetime import datetime
from html import escape

import jdatetime
from telegram import InlineKeyboardButton, InlineKeyboardMarkup

from .ledger import Account
from .parser import asset_name, fa
from .storage import Deal

LINE = "━━━━━━━━━━━━━━━━━━"

STATUS = {
    "pending": ("⏳", "در انتظار تایید"),
    "approving": ("⏳", "در حال ثبت…"),
    "approved": ("✅", "تایید شد"),
    "rejected": ("❌", "رد شد"),
    "cancelled": ("🚫", "لغو شد"),
}
SIDE = {"BUY": ("🟢", "خرید"), "SELL": ("🔴", "فروش"), "PAY": ("💸", "پرداخت"), "RECEIVE": ("📥", "دریافت")}
DIRECTION = {"PAY": "از ما به مشتری", "RECEIVE": "از مشتری به ما"}


def jalali(iso: str) -> str:
    """'2026-10-17T19:05:00+03:30' -> '۱۴۰۵/۰۷/۲۵ – ۱۹:۰۵'"""
    dt = datetime.fromisoformat(iso)
    return fa(jdatetime.datetime.fromgregorian(datetime=dt).strftime("%Y/%m/%d – %H:%M"))


def jalali_date(iso: str) -> str:
    return jalali(iso).split(" – ")[0]


def render(deal: Deal, error: str | None = None, confirm_cancel: bool = False) -> str:
    t = deal.trade
    icon, side = SIDE[t.side]
    name = escape(asset_name(t.asset))
    lines = [
        f"{icon} <b>{side} {fa(t.amount)} {name}</b>",
        f"🆔 <code>{deal.code}</code>",
        LINE,
        f"👤 <b>مشتری:</b> {escape(deal.client)}",
    ]
    if t.is_payment:
        lines.append(f"↔️ <b>جهت:</b> {DIRECTION[t.side]}")
        lines.append(f"💰 <b>مبلغ:</b> {fa(t.amount)} {name}")
    elif t.by_toman:
        lines.append(f"🧾 <b>مبلغ تومانی:</b> {fa(t.total)} تومان")
        lines.append(f"💵 <b>قیمت واحد:</b> {fa(t.rate)} تومان")
        lines.append(f"💰 <b>مقدار {name}:</b> {fa(t.amount)} {name}")
        lines.append(f"<i>   (= {fa(t.total)} ÷ {fa(t.rate)})</i>")
    else:
        lines.append(f"💰 <b>مقدار:</b> {fa(t.amount)} {name}")
    if t.rate is not None and not t.by_toman:
        lines.append(f"💵 <b>قیمت واحد:</b> {fa(t.rate)} تومان")
        lines.append(f"🧾 <b>مبلغ کل:</b> {fa(t.total)} تومان")
    if t.note:
        lines.append(f"📝 <b>توضیحات:</b> {escape(t.note)}")
    status_icon, status = STATUS[deal.status]
    lines += [
        LINE,
        f"🕒 {jalali(deal.created_at)}",
        f"✍️ ثبت توسط {escape(deal.created_by)}",
        "",
        f"{status_icon} <b>وضعیت: {status}</b>",
    ]
    if deal.status in ("approved", "rejected", "cancelled") and deal.decided_by:
        verb = "رد" if deal.status == "rejected" else "تایید"
        lines.append(f"<i>{verb} توسط {escape(deal.decided_by)} · {jalali(deal.decided_at)}</i>")
    if deal.status == "cancelled" and deal.cancelled_by:
        lines.append(f"<i>لغو توسط {escape(deal.cancelled_by)} · {jalali(deal.cancelled_at)}</i>")
    if confirm_cancel:
        lines += ["", "⚠️ <b>این مورد تایید شده است. مطمئن هستید که لغو شود؟</b>"]
    if error:
        lines += ["", f"⚠️ {escape(error)}"]
    return "\n".join(lines)


def keyboard(deal: Deal, confirm_cancel: bool = False) -> InlineKeyboardMarkup | None:
    b = InlineKeyboardButton
    if deal.status == "pending":
        return InlineKeyboardMarkup([
            [b("✅ تایید", callback_data=f"ok:{deal.id}"), b("❌ رد", callback_data=f"no:{deal.id}")],
            [b("🚫 لغو", callback_data=f"cx:{deal.id}")],
        ])
    if deal.status == "approved":
        if confirm_cancel:
            return InlineKeyboardMarkup([[
                b("⚠️ بله، لغو شود", callback_data=f"cy:{deal.id}"),
                b("↩️ بازگشت", callback_data=f"cn:{deal.id}"),
            ]])
        label = "🚫 لغو پرداخت" if deal.trade.is_payment else "🚫 لغو معامله"
        return InlineKeyboardMarkup([[b(label, callback_data=f"cx:{deal.id}")]])
    return None


def render_list(client: str, deals: list[Deal]) -> str:
    if not deals:
        return f"📋 هنوز معامله یا پرداختی با «{escape(client)}» ثبت نشده است."
    lines = [f"📋 <b>معاملات و پرداخت‌ها با «{escape(client)}»</b>", f"<i>{fa(len(deals))} مورد آخر</i>", LINE]
    for d in deals:
        t = d.trade
        status_icon, _ = STATUS[d.status]
        side_icon, side = SIDE[t.side]
        line = f"{side_icon} {side} {fa(t.amount)} {escape(asset_name(t.asset))}"
        if t.is_payment:
            line += f" ({DIRECTION[t.side]})"
        elif t.rate is not None:
            line += f" × {fa(t.rate)} = <b>{fa(t.total)}</b> تومان"
        lines.append(f"{status_icon} <code>{d.code}</code> · {jalali_date(d.created_at)}\n{line}")
    lines += [LINE, "⏳ در انتظار · ✅ تایید · ❌ رد · 🚫 لغو", "تراز حساب: /balance"]
    return "\n".join(lines)


def _debt(asset: str, owed) -> str:
    name = escape(asset_name(asset))
    if owed == 0:
        return f"✅ {name}: تسویه"
    if owed > 0:
        return f"🔴 {name}: مشتری <b>{fa(owed)}</b> {name} به ما بدهکار است"
    return f"🔵 {name}: ما <b>{fa(-owed)}</b> {name} به مشتری بدهکاریم"


def render_balance(client: str, acc: Account) -> str:
    if not acc.count:
        return f"💼 هنوز معامله یا پرداخت تایید شده‌ای با «{escape(client)}» وجود ندارد."
    lines = [
        f"💼 <b>حساب با «{escape(client)}»</b>",
        "<i>بر اساس معاملات و پرداخت‌های تایید شده</i>",
        LINE,
        "🧮 <b>مانده حساب</b>",
    ]
    debts = acc.debts()
    if all(owed == 0 for _, owed in debts):
        lines.append("✅ حساب کاملاً تسویه است.")
    else:
        lines += [_debt(asset, owed) for asset, owed in debts]
    if acc.unpriced:
        lines.append(f"<i>⚠️ {fa(acc.unpriced)} معامله بدون قیمت در مانده تومانی حساب نشده است.</i>")

    for b in acc.trades:
        name = escape(asset_name(b.asset))
        lines += [LINE, f"📊 <b>معاملات {name}</b> · {fa(b.count)} مورد"]
        lines.append(f"🟢 خرید: {fa(b.bought)} {name}" + (f" — {fa(b.buy_toman)} تومان" if b.buy_toman else ""))
        if b.avg_buy:
            lines.append(f"     میانگین خرید: {fa(b.avg_buy.quantize(1))} تومان")
        lines.append(f"🔴 فروش: {fa(b.sold)} {name}" + (f" — {fa(b.sell_toman)} تومان" if b.sell_toman else ""))
        if b.avg_sell:
            lines.append(f"     میانگین فروش: {fa(b.avg_sell.quantize(1))} تومان")

    if acc.paid or acc.received:
        lines += [LINE, "💳 <b>پرداخت‌ها</b>"]
        for asset, amount in sorted(acc.received.items()):
            lines.append(f"📥 دریافتی از مشتری: {fa(amount)} {escape(asset_name(asset))}")
        for asset, amount in sorted(acc.paid.items()):
            lines.append(f"💸 پرداختی به مشتری: {fa(amount)} {escape(asset_name(asset))}")
    lines += [LINE, "<i>ثبت پرداخت: «دریافت ۵۰ میلیون تومن» یا «پرداخت ۱۰۰ تتر»</i>"]
    return "\n".join(lines)
