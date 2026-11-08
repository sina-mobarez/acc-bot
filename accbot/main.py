"""Telegram bot entry point: turns trade messages into approvable deal cards."""

import logging
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from telegram import (
    BotCommand, BotCommandScopeAllGroupChats, BotCommandScopeAllPrivateChats, Chat, InlineKeyboardMarkup,
    Update, User,
)
from telegram.constants import ChatMemberStatus, ParseMode
from telegram.error import BadRequest
from telegram.ext import (
    Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters,
)

from . import card
from .broadcast import Broadcaster
from .ledger import summarize
from .parser import TradeError, normalize, parse_message
from .sheets import Sheet
from .storage import Deal, Store

load_dotenv()
logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s: %(message)s", level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("accbot")

TZ = ZoneInfo(os.getenv("TIMEZONE") or "Asia/Tehran")
DEFAULT_ASSET = os.getenv("DEFAULT_ASSET") or "USDT"
APPROVER_IDS = {int(x) for x in (os.getenv("APPROVER_IDS") or "").replace(" ", "").split(",") if x}

store = Store(os.getenv("DB_PATH") or "deals.db")
sheet = Sheet(
    os.getenv("GOOGLE_CREDENTIALS_FILE") or "credentials.json",
    os.getenv("SHEET_ID") or "",
    os.getenv("WORKSHEET") or "Deals",
)

HELP = (
    "🤖 <b>ربات ثبت معاملات</b>\n\n"
    "معامله را در گروه مشتری بنویسید:\n"
    "<code>#خرید ۱۰۰ تا تتر رو قیمت ۲۷۵۰۰۰ تومن</code>\n"
    "<code>#فروش ۳۰۰ تا تتر رو قیمت ۳۲۰۰۰۰</code>\n"
    "<code>#خرید ۲ میلیون تتر ۲۷۵ هزار بانک ملت</code>\n"
    "<code>#خرید ۵۰۰ میلیون تومان تتر به قیمت ۲۶۴۰۰۰</code>\n"
    "<code>#فروش ۱ میلیارد تومن تتر به قیمت ۲۶۵۰۰۰</code>\n"
    "  ↳ مبلغ تومانی: مقدار تتر = مبلغ ÷ قیمت\n"
    "<code>#sell 100 usdt @ 320000</code>\n\n"
    "ثبت پرداخت (همه از طرف ما):\n"
    "<code>#دریافت ۵۰ میلیون تومن کارت به کارت</code> — مشتری به ما پرداخت کرد\n"
    "<code>#پرداخت ۲۷٬۵۰۰٬۰۰۰ تومن</code> — ما به مشتری پرداخت کردیم\n"
    "<code>#دریافت ۱۰۰ تتر</code> / <code>#ارسال ۲۰۰ تتر</code> — تحویل تتر\n\n"
    "• پیام باید با «خرید»، «فروش»، «پرداخت»، «دریافت» یا «ارسال» شروع شود (حتماً با # شروع شود).\n"
    "• «هزار»، «میلیون» و «میلیارد» (یا k / m / b) پشتیبانی می‌شود.\n"
    "• قیمت با «رو قیمت»، «به قیمت»، «فی» یا @ و هر چیزی بعد از قیمت، توضیحات است.\n\n"
    "ربات یک کارت معامله می‌فرستد؛ با ✅ تایید، معامله در دیتابیس و گوگل شیت ثبت می‌شود.\n\n"
    "/deals — لیست معاملات این گروه (مثلاً <code>/deals 30</code>)\n"
    "/balance — مانده حساب: چه کسی به چه کسی بدهکار است\n"
    "/id — شناسه تلگرام شما\n\n"
    "در چت خصوصی با ربات (فقط مدیران):\n"
    "/broadcast — ارسال پیام به همه گروه‌ها\n"
    "/groups — لیست گروه‌های ربات"
)

COMMANDS = [
    BotCommand("deals", "لیست معاملات با این مشتری"),
    BotCommand("balance", "مانده حساب با این مشتری"),
    BotCommand("help", "راهنما"),
    BotCommand("id", "شناسه تلگرام من"),
]
PRIVATE_COMMANDS = [
    BotCommand("broadcast", "ارسال پیام به همه گروه‌ها"),
    BotCommand("groups", "لیست گروه‌های ربات"),
    BotCommand("cancel", "لغو ارسال همگانی"),
    BotCommand("help", "راهنما"),
    BotCommand("id", "شناسه تلگرام من"),
]


def now() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def who(user: User) -> str:
    return f"@{user.username}" if user.username else user.full_name


def client_name(chat: Chat, user: User) -> str:
    return chat.title or user.full_name


def message_link(chat_id: int, message_id: int | None) -> str:
    # Only supergroups (-100…) have t.me/c links.
    s = str(chat_id)
    if message_id and s.startswith("-100"):
        return f"https://t.me/c/{s[4:]}/{message_id}"
    return ""


broadcaster = Broadcaster(store, APPROVER_IDS, now, who)


async def is_approver(update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
    user, chat = update.effective_user, update.effective_chat
    if APPROVER_IDS:
        return user.id in APPROVER_IDS
    if chat.type == Chat.PRIVATE:
        return True
    member = await context.bot.get_chat_member(chat.id, user.id)
    return member.status in (ChatMemberStatus.OWNER, ChatMemberStatus.ADMINISTRATOR)


async def show(query, deal: Deal, markup: InlineKeyboardMarkup | None = None, **render_kw) -> None:
    try:
        await query.edit_message_text(card.render(deal, **render_kw), parse_mode=ParseMode.HTML,
                                      reply_markup=markup)
    except BadRequest as e:
        if "not modified" not in str(e).lower():
            raise


async def on_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text(HELP, parse_mode=ParseMode.HTML)


async def on_id(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.effective_message.reply_text(
        f"شناسه شما: <code>{update.effective_user.id}</code>\n"
        f"شناسه گروه: <code>{update.effective_chat.id}</code>",
        parse_mode=ParseMode.HTML,
    )


async def on_trade(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg, user = update.effective_message, update.effective_user
    try:
        trade = parse_message(msg.text, DEFAULT_ASSET)
    except TradeError as e:
        await msg.reply_text(f"⚠️ {e}")
        return
    if trade is None:
        return
    deal = store.create(
        chat_id=msg.chat_id, source_msg_id=msg.message_id,
        client=client_name(update.effective_chat, user), trade=trade, raw_text=msg.text,
        created_by=who(user), created_by_id=user.id, created_at=now(),
    )
    sent = await msg.reply_text(card.render(deal), parse_mode=ParseMode.HTML, reply_markup=card.keyboard(deal))
    store.set_message(deal.id, sent.message_id)
    log.info("Created %s in %s: %s", deal.code, deal.client, msg.text)


async def on_deals(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat = update.effective_chat
    limit = 15
    if context.args and normalize(context.args[0]).isdigit():
        limit = max(1, min(40, int(normalize(context.args[0]))))
    deals = store.recent(chat.id, limit)
    text = card.render_list(client_name(chat, update.effective_user), deals)
    await update.effective_message.reply_text(text, parse_mode=ParseMode.HTML)


async def on_balance(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat = update.effective_chat
    account = summarize([d.trade for d in store.approved(chat.id)])
    text = card.render_balance(client_name(chat, update.effective_user), account)
    await update.effective_message.reply_text(text, parse_mode=ParseMode.HTML)


async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    action, _, raw_id = (query.data or "").partition(":")
    deal = store.get(int(raw_id)) if raw_id.isdigit() else None
    if deal is None:
        await query.answer("معامله پیدا نشد.", show_alert=True)
        return

    user = update.effective_user
    actor, at = who(user), now()
    approver = await is_approver(update, context)
    deny = "شما اجازه این کار را ندارید."

    if action == "cx" and deal.status == "pending":
        # The person who wrote the deal may withdraw it; approvers may too.
        if not (approver or user.id == deal.created_by_id):
            await query.answer(deny, show_alert=True)
            return
        if store.transition(deal.id, "pending", "cancelled", cancelled_by=actor, cancelled_at=at):
            await query.answer("معامله لغو شد.")
        await show(query, store.get(deal.id))
        return

    if not approver:
        await query.answer(deny, show_alert=True)
        return

    if action == "no":
        if store.transition(deal.id, "pending", "rejected", decided_by=actor, decided_at=at):
            await query.answer("معامله رد شد.")
        else:
            await query.answer("این معامله قبلاً بررسی شده است.")
        await show(query, store.get(deal.id))
        return

    if action == "ok":
        await approve(query, deal, actor, at)
        return

    if action == "cx" and deal.status == "approved":
        await query.answer()
        await show(query, deal, card.keyboard(deal, confirm_cancel=True), confirm_cancel=True)
        return

    if action == "cn":
        await query.answer()
        await show(query, deal, card.keyboard(deal))
        return

    if action == "cy":
        if not store.transition(deal.id, "approved", "cancelled", cancelled_by=actor, cancelled_at=at):
            await query.answer("این معامله قابل لغو نیست.")
            deal = store.get(deal.id)
            await show(query, deal, card.keyboard(deal))
            return
        await query.answer("معامله لغو شد.")
        deal = store.get(deal.id)
        error = None
        if sheet.enabled:
            try:
                await sheet.set_status(deal, "لغو شده")
            except Exception:
                log.exception("Sheet status update failed for %s", deal.code)
                error = "وضعیت در گوگل شیت به‌روز نشد؛ لطفاً دستی اصلاح کنید."
        await show(query, deal, error=error)
        log.info("Cancelled approved %s by %s", deal.code, actor)
        return

    await query.answer("این معامله قبلاً بررسی شده است.")
    await show(query, deal, card.keyboard(deal))


async def approve(query, deal: Deal, actor: str, at: str) -> None:
    # Lock the deal while writing to the sheet so a double tap can't save it twice.
    if not store.transition(deal.id, "pending", "approving", decided_by=actor, decided_at=at):
        await query.answer("این معامله قبلاً بررسی شده است.")
        return
    await query.answer("در حال ثبت…")
    deal = store.get(deal.id)
    await show(query, deal)

    if sheet.enabled:
        try:
            await sheet.append(deal, card.jalali(deal.created_at), card.jalali(at),
                               message_link(deal.chat_id, deal.message_id))
        except Exception:
            log.exception("Sheet append failed for %s", deal.code)
            store.transition(deal.id, "approving", "pending")
            deal = store.get(deal.id)
            await show(query, deal, card.keyboard(deal), error="ثبت در گوگل شیت انجام نشد؛ دوباره تایید کنید.")
            return

    store.transition(deal.id, "approving", "approved")
    deal = store.get(deal.id)
    await show(query, deal, card.keyboard(deal))
    log.info("Approved %s by %s", deal.code, actor)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.error("Unhandled error", exc_info=context.error)


async def post_init(app: Application) -> None:
    await app.bot.set_my_commands(COMMANDS, scope=BotCommandScopeAllGroupChats())
    await app.bot.set_my_commands(PRIVATE_COMMANDS, scope=BotCommandScopeAllPrivateChats())
    me = await app.bot.get_me()
    log.info("Running as @%s (reads all group messages: %s, sheet: %s)",
             me.username, me.can_read_all_group_messages, "on" if sheet.enabled else "off")
    await broadcaster.refresh(app)


def main() -> None:
    token = os.getenv("BOT_TOKEN")
    if not token:
        raise SystemExit("BOT_TOKEN is not set (see .env.example)")
    builder = Application.builder().token(token).post_init(post_init)
    if proxy := os.getenv("PROXY_URL"):
        builder = builder.proxy(proxy).get_updates_proxy(proxy)
    app = builder.build()
    broadcaster.register(app)
    app.add_handler(CommandHandler(["start", "help"], on_help))
    app.add_handler(CommandHandler("id", on_id))
    app.add_handler(CommandHandler("deals", on_deals))
    app.add_handler(CommandHandler("balance", on_balance))
    app.add_handler(MessageHandler(filters.UpdateType.MESSAGE & filters.TEXT & ~filters.COMMAND, on_trade))
    app.add_handler(CallbackQueryHandler(on_button, pattern=r"^(ok|no|cx|cy|cn):\d+$"))
    app.add_error_handler(on_error)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
