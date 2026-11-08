"""Broadcast a message to every group the bot is in, and keep the group list current.

Flow (private chat, approvers only):
    /broadcast -> send any message -> preview with group count -> ✅ send
    -> report (sent / failed) with a 🗑 button that deletes the copies everywhere.

Callback data: bc:go / bc:no (confirm the pending message), bd:<id> / bdy:<id> / bdn:<id>
(delete a sent broadcast: ask / confirm / keep).
"""

import asyncio
import logging
from collections.abc import Callable
from html import escape

from telegram import Chat, ChatMemberUpdated, InlineKeyboardButton, InlineKeyboardMarkup, Message, Update, User
from telegram.constants import ParseMode
from telegram.error import BadRequest, ChatMigrated, Forbidden, RetryAfter, TelegramError
from telegram.ext import (
    Application, ApplicationHandlerStop, CallbackQueryHandler, ChatMemberHandler, CommandHandler,
    ContextTypes, MessageHandler, TypeHandler, filters,
)

from .parser import fa
from .storage import ChatInfo, Store

log = logging.getLogger(__name__)

GROUP_TYPES = (Chat.GROUP, Chat.SUPERGROUP)
SEND_DELAY = 0.05  # stays well under Telegram's ~30 messages/second limit
WAITING = "broadcast_waiting"
SOURCE = "broadcast_source"


def _preview(msg: Message) -> str:
    text = msg.text or msg.caption or ""
    kind = next((k for k in ("photo", "video", "document", "audio", "voice", "animation", "sticker") if getattr(msg, k)), "")
    preview = (f"[{kind}] " if kind else "") + text
    return preview[:200] or "[پیام]"


class Broadcaster:
    def __init__(self, store: Store, approver_ids: set[int], now: Callable[[], str], who: Callable[[User], str]):
        self.store = store
        self.approver_ids = approver_ids
        self.now = now
        self.who = who

    def register(self, app: Application) -> None:
        # Group -2: see every update first to keep the group list current.
        app.add_handler(TypeHandler(Update, self.track_chat), group=-2)
        # Group -1: while waiting for a broadcast message, consume it before deal parsing.
        app.add_handler(
            MessageHandler(filters.ChatType.PRIVATE & ~filters.COMMAND, self.on_private_message), group=-1
        )
        app.add_handler(ChatMemberHandler(self.on_my_chat_member, ChatMemberHandler.MY_CHAT_MEMBER))
        app.add_handler(CommandHandler("broadcast", self.on_broadcast, filters.ChatType.PRIVATE))
        app.add_handler(CommandHandler("cancel", self.on_cancel, filters.ChatType.PRIVATE))
        app.add_handler(CommandHandler("groups", self.on_groups, filters.ChatType.PRIVATE))
        app.add_handler(CallbackQueryHandler(self.on_button, pattern=r"^(bc:(go|no)|bd:\d+|bdy:\d+|bdn:\d+)$"))

    # --- group tracking ----------------------------------------------------

    async def track_chat(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        msg = update.effective_message
        if msg and msg.migrate_to_chat_id:
            log.info("Group %s migrated to %s", msg.chat_id, msg.migrate_to_chat_id)
            self.store.migrate_chat(msg.chat_id, msg.migrate_to_chat_id)
            return
        chat = update.effective_chat
        if chat and chat.type in GROUP_TYPES and not update.my_chat_member:
            self.store.upsert_chat(chat.id, chat.title or str(chat.id), chat.type, self.now())

    async def on_my_chat_member(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        change: ChatMemberUpdated = update.my_chat_member
        chat = change.chat
        if chat.type not in GROUP_TYPES:
            return
        status = change.new_chat_member.status
        self.store.upsert_chat(chat.id, chat.title or str(chat.id), chat.type, self.now(), status=status)
        log.info("Bot is now %s in %s (%s)", status, chat.title, chat.id)

    async def refresh(self, app: Application) -> None:
        """At startup: add groups known from deals and re-check the bot's status everywhere."""
        known = {c.chat_id for c in self.store.chats(active_only=False)}
        ids = known | set(self.store.deal_chat_ids())
        for chat_id in ids:
            try:
                chat = await app.bot.get_chat(chat_id)
                member = await app.bot.get_chat_member(chat_id, app.bot.id)
                self.store.upsert_chat(chat_id, chat.title or str(chat_id), chat.type, self.now(),
                                       status=member.status)
            except ChatMigrated as e:
                self.store.migrate_chat(chat_id, e.new_chat_id)
            except (Forbidden, BadRequest) as e:
                if chat_id in known:
                    self.store.set_chat_status(chat_id, "left", self.now())
                log.info("Group %s unreachable: %s", chat_id, e)
            await asyncio.sleep(SEND_DELAY)
        log.info("Groups: %d active of %d known", len(self.store.chats()), len(ids))

    # --- commands ----------------------------------------------------------

    def allowed(self, user: User) -> bool:
        # Never fall back to "anyone": a private chat has no admins to check.
        return bool(self.approver_ids) and user.id in self.approver_ids

    async def deny(self, update: Update) -> None:
        user = update.effective_user
        if self.approver_ids:
            text = "⛔️ شما اجازه ارسال همگانی ندارید."
        else:
            text = (
                "⛔️ ارسال همگانی هنوز فعال نشده است.\n"
                f"برای فعال‌سازی، شناسه شما (<code>{user.id}</code>) را در <code>APPROVER_IDS</code> "
                "فایل .env سرور قرار دهید و ربات را ری‌استارت کنید."
            )
        await update.effective_message.reply_text(text, parse_mode=ParseMode.HTML)

    async def on_broadcast(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.allowed(update.effective_user):
            await self.deny(update)
            return
        msg = update.effective_message
        if msg.reply_to_message:
            await self.ask_confirm(msg.reply_to_message, context)
            return
        context.user_data[WAITING] = True
        await msg.reply_text(
            f"📣 پیامی که می‌خواهید به همه گروه‌ها ({fa(len(self.store.chats()))} گروه) ارسال شود را بفرستید.\n"
            "متن، عکس، فایل یا ویدیو — همان‌طور که هست کپی می‌شود.\n\nانصراف: /cancel"
        )

    async def on_cancel(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        was_active = context.user_data.pop(WAITING, None) or context.user_data.pop(SOURCE, None)
        await update.effective_message.reply_text("لغو شد." if was_active else "کاری برای لغو وجود ندارد.")

    async def on_groups(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self.allowed(update.effective_user):
            await self.deny(update)
            return
        chats = self.store.chats()
        if not chats:
            await update.effective_message.reply_text("ربات هنوز در هیچ گروهی ثبت نشده است.")
            return
        lines = [f"👥 <b>گروه‌های ربات</b> · {fa(len(chats))} گروه", ""]
        lines += [f"{'👑' if c.is_admin else '👤'} {escape(c.title)}" for c in chats]
        lines += ["", "👑 ادمین · 👤 عضو"]
        await update.effective_message.reply_text("\n".join(lines), parse_mode=ParseMode.HTML)

    async def on_private_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not context.user_data.get(WAITING):
            return
        if not self.allowed(update.effective_user):
            context.user_data.pop(WAITING, None)
            return
        context.user_data.pop(WAITING, None)
        await self.ask_confirm(update.effective_message, context)
        raise ApplicationHandlerStop  # don't treat the broadcast text as a deal

    async def ask_confirm(self, source: Message, context: ContextTypes.DEFAULT_TYPE) -> None:
        chats = self.store.chats()
        if not chats:
            await source.reply_text("ربات در هیچ گروهی عضو نیست.")
            return
        context.user_data[SOURCE] = (source.chat_id, source.message_id, _preview(source))
        names = "، ".join(escape(c.title) for c in chats[:15]) + (" و …" if len(chats) > 15 else "")
        await source.reply_text(
            f"📣 این پیام به <b>{fa(len(chats))} گروه</b> ارسال شود؟\n\n<i>{names}</i>",
            parse_mode=ParseMode.HTML,
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(f"✅ ارسال به {fa(len(chats))} گروه", callback_data="bc:go"),
                InlineKeyboardButton("❌ انصراف", callback_data="bc:no"),
            ]]),
        )

    # --- buttons -----------------------------------------------------------

    async def on_button(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        if not self.allowed(update.effective_user):
            await query.answer("شما اجازه این کار را ندارید.", show_alert=True)
            return
        action, _, raw_id = query.data.partition(":")

        if query.data == "bc:no":
            context.user_data.pop(SOURCE, None)
            await query.answer()
            await query.edit_message_text("❌ ارسال همگانی لغو شد.")
            return

        if query.data == "bc:go":
            source = context.user_data.pop(SOURCE, None)
            if source is None:
                await query.answer("این درخواست منقضی شده است؛ دوباره /broadcast بزنید.", show_alert=True)
                return
            await query.answer("در حال ارسال…")
            chats = self.store.chats()
            await query.edit_message_text(f"⏳ در حال ارسال به {fa(len(chats))} گروه…")
            # Run in the background so deals keep working during a long broadcast.
            context.application.create_task(self.send_all(query.message, source, chats, update.effective_user))
            return

        broadcast_id = int(raw_id)
        if action == "bd":
            await query.answer()
            await query.edit_message_reply_markup(InlineKeyboardMarkup([[
                InlineKeyboardButton("⚠️ بله، از همه گروه‌ها حذف شود", callback_data=f"bdy:{broadcast_id}"),
                InlineKeyboardButton("↩️ بازگشت", callback_data=f"bdn:{broadcast_id}"),
            ]]))
        elif action == "bdn":
            await query.answer()
            await query.edit_message_reply_markup(self.delete_keyboard(broadcast_id))
        elif action == "bdy":
            if not self.store.mark_broadcast_deleted(broadcast_id, self.now()):
                await query.answer("این پیام قبلاً حذف شده است.")
                await query.edit_message_reply_markup(None)
                return
            await query.answer("در حال حذف…")
            await query.edit_message_reply_markup(None)
            context.application.create_task(self.delete_all(query.message, broadcast_id))

    @staticmethod
    def delete_keyboard(broadcast_id: int) -> InlineKeyboardMarkup:
        return InlineKeyboardMarkup([[
            InlineKeyboardButton("🗑 حذف از همه گروه‌ها", callback_data=f"bd:{broadcast_id}")
        ]])

    # --- sending -----------------------------------------------------------

    async def send_all(self, status_msg: Message, source: tuple[int, int, str], chats: list[ChatInfo],
                       user: User) -> None:
        bot = status_msg.get_bot()
        from_chat_id, from_message_id, preview = source
        broadcast_id = self.store.create_broadcast(
            from_chat_id=from_chat_id, from_message_id=from_message_id, preview=preview,
            created_by=self.who(user), created_by_id=user.id, created_at=self.now(),
        )
        sent, failed = 0, []
        for chat in chats:
            message_id, error = await self.send_one(bot, chat, from_chat_id, from_message_id)
            self.store.record_delivery(broadcast_id, chat.chat_id, message_id, error)
            if message_id:
                sent += 1
            else:
                failed.append((chat.title, error))
            await asyncio.sleep(SEND_DELAY)
        log.info("Broadcast %s by %s: %d sent, %d failed", broadcast_id, self.who(user), sent, len(failed))

        lines = [f"📣 <b>ارسال همگانی #{fa(broadcast_id)}</b>", f"✅ ارسال شد: {fa(sent)} از {fa(len(chats))} گروه"]
        if failed:
            lines.append(f"⚠️ ناموفق: {fa(len(failed))}")
            lines += [f"  • {escape(title)} — <i>{escape(err or '')}</i>" for title, err in failed[:20]]
        await status_msg.edit_text(
            "\n".join(lines), parse_mode=ParseMode.HTML,
            reply_markup=self.delete_keyboard(broadcast_id) if sent else None,
        )

    async def send_one(self, bot, chat: ChatInfo, from_chat_id: int, from_message_id: int) -> tuple[int | None, str | None]:
        chat_id = chat.chat_id
        for _ in range(3):
            try:
                copied = await bot.copy_message(chat_id, from_chat_id, from_message_id)
                return copied.message_id, None
            except RetryAfter as e:
                wait = e.retry_after  # seconds, or a timedelta in newer PTB versions
                await asyncio.sleep((wait.total_seconds() if hasattr(wait, "total_seconds") else wait) + 1)
            except ChatMigrated as e:
                self.store.migrate_chat(chat_id, e.new_chat_id)
                chat_id = e.new_chat_id
            except Forbidden:
                # Removed from the group or not allowed to write: stop sending there.
                self.store.set_chat_status(chat_id, "left", self.now())
                return None, "ربات از گروه حذف شده یا اجازه ارسال ندارد"
            except TelegramError as e:
                log.warning("Broadcast to %s failed: %s", chat_id, e)
                return None, str(e)
        return None, "محدودیت تلگرام؛ ارسال انجام نشد"

    async def delete_all(self, status_msg: Message, broadcast_id: int) -> None:
        bot = status_msg.get_bot()
        deleted = failed = 0
        for chat_id, message_id in self.store.deliveries(broadcast_id):
            try:
                await bot.delete_message(chat_id, message_id)
                deleted += 1
            except TelegramError as e:
                log.info("Could not delete broadcast %s in %s: %s", broadcast_id, chat_id, e)
                failed += 1
            await asyncio.sleep(SEND_DELAY)
        text = status_msg.text_html + f"\n\n🗑 حذف شد از {fa(deleted)} گروه"
        if failed:
            text += f" · ناموفق: {fa(failed)} (پیام‌های قدیمی‌تر از ۴۸ ساعت قابل حذف نیستند)"
        await status_msg.edit_text(text, parse_mode=ParseMode.HTML)
