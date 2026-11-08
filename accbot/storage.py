"""SQLite store: deals and their status history, the groups the bot is in, and broadcasts."""

import sqlite3
from dataclasses import dataclass
from decimal import Decimal

from .parser import Trade

SCHEMA = """
CREATE TABLE IF NOT EXISTS deals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id        INTEGER NOT NULL,
    message_id     INTEGER,
    source_msg_id  INTEGER,
    client         TEXT NOT NULL,
    side           TEXT NOT NULL,
    amount         TEXT NOT NULL,
    asset          TEXT NOT NULL,
    rate           TEXT,
    toman_total    TEXT,
    note           TEXT NOT NULL DEFAULT '',
    raw_text       TEXT NOT NULL DEFAULT '',
    created_by     TEXT NOT NULL,
    created_by_id  INTEGER NOT NULL,
    created_at     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    decided_by     TEXT,
    decided_at     TEXT,
    cancelled_by   TEXT,
    cancelled_at   TEXT
);
CREATE INDEX IF NOT EXISTS deals_chat ON deals (chat_id, id);

-- Telegram has no "list my chats" call, so groups are recorded as the bot sees them.
CREATE TABLE IF NOT EXISTS chats (
    chat_id     INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    type        TEXT NOT NULL,
    status      TEXT NOT NULL,  -- the bot's own status: member, administrator, left, kicked, …
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS broadcasts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    from_chat_id     INTEGER NOT NULL,
    from_message_id  INTEGER NOT NULL,
    preview          TEXT NOT NULL,
    created_by       TEXT NOT NULL,
    created_by_id    INTEGER NOT NULL,
    created_at       TEXT NOT NULL,
    deleted_at       TEXT
);

CREATE TABLE IF NOT EXISTS broadcast_messages (
    broadcast_id  INTEGER NOT NULL,
    chat_id       INTEGER NOT NULL,
    message_id    INTEGER,  -- NULL when sending failed
    error         TEXT,
    PRIMARY KEY (broadcast_id, chat_id)
);
"""

ACTIVE_STATUSES = ("member", "administrator", "creator")

# Columns added after the first deployment: (name, definition).
MIGRATIONS = [("toman_total", "TEXT")]

# pending -> approving -> approved -> cancelled
#         -> rejected
#         -> cancelled
STATUSES = ("pending", "approving", "approved", "rejected", "cancelled")


@dataclass
class ChatInfo:
    chat_id: int
    title: str
    type: str
    status: str

    @property
    def is_admin(self) -> bool:
        return self.status in ("administrator", "creator")


@dataclass
class Deal:
    id: int
    chat_id: int
    message_id: int | None
    client: str
    trade: Trade
    created_by: str
    created_by_id: int
    created_at: str
    status: str
    decided_by: str | None
    decided_at: str | None
    cancelled_by: str | None
    cancelled_at: str | None

    @property
    def code(self) -> str:
        return f"D-{self.id:05d}"


def _deal(row: sqlite3.Row) -> Deal:
    return Deal(
        id=row["id"], chat_id=row["chat_id"], message_id=row["message_id"], client=row["client"],
        trade=Trade(
            side=row["side"], amount=Decimal(row["amount"]), asset=row["asset"],
            rate=Decimal(row["rate"]) if row["rate"] else None, note=row["note"],
            toman_total=Decimal(row["toman_total"]) if row["toman_total"] else None,
        ),
        created_by=row["created_by"], created_by_id=row["created_by_id"], created_at=row["created_at"],
        status=row["status"], decided_by=row["decided_by"], decided_at=row["decided_at"],
        cancelled_by=row["cancelled_by"], cancelled_at=row["cancelled_at"],
    )


class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        existing = {r["name"] for r in self.db.execute("PRAGMA table_info(deals)")}
        for name, definition in MIGRATIONS:
            if name not in existing:
                self.db.execute(f"ALTER TABLE deals ADD COLUMN {name} {definition}")

    def create(self, *, chat_id: int, source_msg_id: int, client: str, trade: Trade, raw_text: str,
               created_by: str, created_by_id: int, created_at: str) -> Deal:
        cur = self.db.execute(
            "INSERT INTO deals (chat_id, source_msg_id, client, side, amount, asset, rate, toman_total, note,"
            " raw_text, created_by, created_by_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (chat_id, source_msg_id, client, trade.side, str(trade.amount), trade.asset,
             str(trade.rate) if trade.rate is not None else None,
             str(trade.toman_total) if trade.toman_total is not None else None, trade.note, raw_text,
             created_by, created_by_id, created_at),
        )
        return self.get(cur.lastrowid)

    def set_message(self, deal_id: int, message_id: int) -> None:
        self.db.execute("UPDATE deals SET message_id = ? WHERE id = ?", (message_id, deal_id))

    def get(self, deal_id: int) -> Deal | None:
        row = self.db.execute("SELECT * FROM deals WHERE id = ?", (deal_id,)).fetchone()
        return _deal(row) if row else None

    def recent(self, chat_id: int, limit: int) -> list[Deal]:
        rows = self.db.execute(
            "SELECT * FROM deals WHERE chat_id = ? ORDER BY id DESC LIMIT ?", (chat_id, limit)
        ).fetchall()
        return [_deal(r) for r in rows]

    def approved(self, chat_id: int) -> list[Deal]:
        rows = self.db.execute(
            "SELECT * FROM deals WHERE chat_id = ? AND status = 'approved' ORDER BY id", (chat_id,)
        ).fetchall()
        return [_deal(r) for r in rows]

    def transition(self, deal_id: int, from_status: str, to_status: str, **fields: str) -> bool:
        """Atomically move a deal between statuses; False if it wasn't in from_status."""
        allowed = {"decided_by", "decided_at", "cancelled_by", "cancelled_at"}
        assert set(fields) <= allowed, fields
        sets = "".join(f", {k} = ?" for k in fields)
        cur = self.db.execute(
            f"UPDATE deals SET status = ?{sets} WHERE id = ? AND status = ?",
            (to_status, *fields.values(), deal_id, from_status),
        )
        return cur.rowcount == 1

    # --- chats -------------------------------------------------------------

    def upsert_chat(self, chat_id: int, title: str, type_: str, at: str, status: str | None = None) -> None:
        """Record a group. Without a status, seeing the chat means the bot is (at least) a member."""
        if status is None:
            self.db.execute(
                "INSERT INTO chats (chat_id, title, type, status, updated_at) VALUES (?, ?, ?, 'member', ?)"
                " ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title, type = excluded.type,"
                " updated_at = excluded.updated_at,"
                " status = CASE WHEN chats.status IN ('left', 'kicked') THEN 'member' ELSE chats.status END",
                (chat_id, title, type_, at),
            )
        else:
            self.db.execute(
                "INSERT INTO chats (chat_id, title, type, status, updated_at) VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title, type = excluded.type,"
                " status = excluded.status, updated_at = excluded.updated_at",
                (chat_id, title, type_, status, at),
            )

    def set_chat_status(self, chat_id: int, status: str, at: str) -> None:
        self.db.execute("UPDATE chats SET status = ?, updated_at = ? WHERE chat_id = ?", (status, at, chat_id))

    def migrate_chat(self, old_id: int, new_id: int) -> None:
        """A group upgraded to a supergroup gets a new id; keep its deals and record."""
        self.db.execute("UPDATE deals SET chat_id = ? WHERE chat_id = ?", (new_id, old_id))
        self.db.execute("DELETE FROM chats WHERE chat_id = ?", (new_id,))
        self.db.execute("UPDATE chats SET chat_id = ? WHERE chat_id = ?", (new_id, old_id))

    def chats(self, active_only: bool = True) -> list[ChatInfo]:
        sql = "SELECT * FROM chats"
        if active_only:
            sql += f" WHERE status IN ({', '.join('?' * len(ACTIVE_STATUSES))})"
        rows = self.db.execute(sql + " ORDER BY title", ACTIVE_STATUSES if active_only else ()).fetchall()
        return [ChatInfo(r["chat_id"], r["title"], r["type"], r["status"]) for r in rows]

    def deal_chat_ids(self) -> list[int]:
        return [r[0] for r in self.db.execute("SELECT DISTINCT chat_id FROM deals")]

    # --- broadcasts --------------------------------------------------------

    def create_broadcast(self, *, from_chat_id: int, from_message_id: int, preview: str,
                         created_by: str, created_by_id: int, created_at: str) -> int:
        cur = self.db.execute(
            "INSERT INTO broadcasts (from_chat_id, from_message_id, preview, created_by, created_by_id, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (from_chat_id, from_message_id, preview, created_by, created_by_id, created_at),
        )
        return cur.lastrowid

    def record_delivery(self, broadcast_id: int, chat_id: int, message_id: int | None, error: str | None) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO broadcast_messages (broadcast_id, chat_id, message_id, error) VALUES (?, ?, ?, ?)",
            (broadcast_id, chat_id, message_id, error),
        )

    def deliveries(self, broadcast_id: int) -> list[tuple[int, int]]:
        """(chat_id, message_id) of every copy that was actually sent."""
        rows = self.db.execute(
            "SELECT chat_id, message_id FROM broadcast_messages WHERE broadcast_id = ? AND message_id IS NOT NULL",
            (broadcast_id,),
        ).fetchall()
        return [(r[0], r[1]) for r in rows]

    def mark_broadcast_deleted(self, broadcast_id: int, at: str) -> bool:
        cur = self.db.execute(
            "UPDATE broadcasts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", (at, broadcast_id)
        )
        return cur.rowcount == 1
