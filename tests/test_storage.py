from decimal import Decimal as D

from accbot.parser import Trade
from accbot.storage import Store


def make(store, chat=1):
    return store.create(chat_id=chat, source_msg_id=1, client="C", trade=Trade("BUY", D(100), "USDT", D(5)),
                        raw_text="x", created_by="@u", created_by_id=7, created_at="2026-10-17T19:00:00+03:30")


def test_transitions_are_exclusive():
    s = Store(":memory:")
    d = make(s)
    assert s.transition(d.id, "pending", "approving", decided_by="@a", decided_at="t")
    assert not s.transition(d.id, "pending", "approving")  # double tap
    assert s.transition(d.id, "approving", "approved")
    assert [x.id for x in s.approved(1)] == [d.id]
    assert s.transition(d.id, "approved", "cancelled", cancelled_by="@a", cancelled_at="t")
    assert s.approved(1) == []


def test_recent_is_per_chat_newest_first():
    s = Store(":memory:")
    a, b, _ = make(s), make(s), make(s, chat=2)
    assert [x.id for x in s.recent(1, 10)] == [b.id, a.id]


def test_toman_total_round_trips():
    from accbot.parser import parse_trade
    s = Store(":memory:")
    t = parse_trade("#خرید ۵۰۰ میلیون تومان به قیمت ۲۶۴۰۰۰")
    d = s.create(chat_id=1, source_msg_id=1, client="C", trade=t, raw_text="x", created_by="@u",
                 created_by_id=7, created_at="2026-10-17T19:00:00+03:30")
    assert s.get(d.id).trade == t


def test_migrates_old_db(tmp_path):
    import sqlite3
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.execute("CREATE TABLE deals (id INTEGER PRIMARY KEY, chat_id INTEGER, message_id INTEGER,"
                " source_msg_id INTEGER, client TEXT, side TEXT, amount TEXT, asset TEXT, rate TEXT,"
                " note TEXT, raw_text TEXT, created_by TEXT, created_by_id INTEGER, created_at TEXT,"
                " status TEXT, decided_by TEXT, decided_at TEXT, cancelled_by TEXT, cancelled_at TEXT)")
    old.execute("INSERT INTO deals VALUES (1, 1, 1, 1, 'C', 'BUY', '100', 'USDT', '5', '', '', '@u', 7,"
                " '2026-10-17T19:00:00+03:30', 'approved', NULL, NULL, NULL, NULL)")
    old.commit()
    old.close()
    d = Store(str(path)).get(1)
    assert d.trade.toman_total is None and d.trade.total == D(500)
