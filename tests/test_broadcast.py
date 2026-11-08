import asyncio
from types import SimpleNamespace

from telegram.error import ChatMigrated, Forbidden, RetryAfter

from accbot.broadcast import Broadcaster
from accbot.storage import Store

NOW = "2026-10-31T10:00:00+03:30"


def make_store():
    s = Store(":memory:")
    s.upsert_chat(-1, "Alpha", "supergroup", NOW, status="administrator")
    s.upsert_chat(-2, "Beta", "group", NOW, status="member")
    s.upsert_chat(-3, "Gone", "group", NOW, status="kicked")
    return s


def test_active_chats_exclude_left_and_kicked():
    s = make_store()
    assert [c.title for c in s.chats()] == ["Alpha", "Beta"]
    assert s.chats()[0].is_admin and not s.chats()[1].is_admin


def test_seeing_a_message_keeps_admin_status_but_revives_left():
    s = make_store()
    s.upsert_chat(-1, "Alpha renamed", "supergroup", NOW)
    s.upsert_chat(-3, "Gone", "group", NOW)
    by_id = {c.chat_id: c for c in s.chats()}
    assert by_id[-1].status == "administrator" and by_id[-1].title == "Alpha renamed"
    assert by_id[-3].status == "member"


def test_migrate_moves_deals_and_chat():
    from decimal import Decimal as D
    from accbot.parser import Trade
    s = make_store()
    s.create(chat_id=-2, source_msg_id=1, client="Beta", trade=Trade("BUY", D(1), "USDT"), raw_text="x",
             created_by="@u", created_by_id=1, created_at=NOW)
    s.migrate_chat(-2, -1002)
    assert s.deal_chat_ids() == [-1002]
    assert -1002 in {c.chat_id for c in s.chats()}


class FakeBot:
    def __init__(self, behaviour):
        self.behaviour = behaviour  # chat_id -> list of exceptions to raise before succeeding
        self.copies, self.deleted = [], []

    async def copy_message(self, chat_id, from_chat_id, message_id):
        queue = self.behaviour.get(chat_id, [])
        if queue:
            raise queue.pop(0)
        self.copies.append(chat_id)
        return SimpleNamespace(message_id=100 + len(self.copies))

    async def delete_message(self, chat_id, message_id):
        self.deleted.append((chat_id, message_id))


class FakeStatus:
    def __init__(self, bot):
        self.bot, self.text_html, self.edits = bot, "report", []

    def get_bot(self):
        return self.bot

    async def edit_text(self, text, **kw):
        self.edits.append((text, kw))


def run_broadcast(store, bot):
    b = Broadcaster(store, {7}, lambda: NOW, lambda u: "@boss")
    b_status = FakeStatus(bot)
    import accbot.broadcast as mod
    mod.SEND_DELAY = 0
    user = SimpleNamespace(id=7)
    asyncio.run(b.send_all(b_status, (7, 55, "hello"), store.chats(), user))
    return b, b_status


def test_send_all_records_deliveries_and_drops_kicked_groups():
    s = make_store()
    bot = FakeBot({-2: [Forbidden("bot was kicked")]})
    _, status = run_broadcast(s, bot)
    assert bot.copies == [-1]
    assert s.deliveries(1) == [(-1, 101)]
    assert [c.title for c in s.chats()] == ["Alpha"]  # Beta marked left
    text, kw = status.edits[-1]
    assert "۱ از ۲" in text and kw["reply_markup"] is not None


def test_send_all_retries_rate_limit_and_follows_migration():
    s = make_store()
    bot = FakeBot({-1: [RetryAfter(0)], -2: [ChatMigrated(-1002)]})
    run_broadcast(s, bot)
    assert sorted(bot.copies) == [-1002, -1]


def test_delete_all_removes_every_copy():
    s = make_store()
    bot = FakeBot({})
    b, status = run_broadcast(s, bot)
    assert s.mark_broadcast_deleted(1, NOW) and not s.mark_broadcast_deleted(1, NOW)
    asyncio.run(b.delete_all(status, 1))
    assert sorted(bot.deleted) == [(-2, 102), (-1, 101)]


def test_only_listed_approvers_may_broadcast():
    s = Store(":memory:")
    assert not Broadcaster(s, set(), lambda: NOW, str).allowed(SimpleNamespace(id=7))
    assert Broadcaster(s, {7}, lambda: NOW, str).allowed(SimpleNamespace(id=7))
    assert not Broadcaster(s, {7}, lambda: NOW, str).allowed(SimpleNamespace(id=8))
