CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BUY','SELL','PAY','RECEIVE')),
  amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  rate TEXT,
  toman_total TEXT,
  note TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL DEFAULT '',
  joke TEXT,
  linked_deal_id INTEGER,
  batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  card_msg_id INTEGER,
  source_msg_id INTEGER,
  created_by TEXT NOT NULL,
  created_by_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT
);
CREATE INDEX entries_chat ON entries (chat_id, id);
CREATE INDEX entries_batch ON entries (batch_id);

CREATE TABLE entry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('edit','cancel')),
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX entry_events_entry ON entry_events (entry_id);

CREATE TABLE pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('edit')),
  entry_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','discarded'))
);

CREATE TABLE accounts (
  chat_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  display_name TEXT,
  type TEXT NOT NULL,
  bot_status TEXT NOT NULL DEFAULT 'member',
  reminders_on INTEGER NOT NULL DEFAULT 1,
  humor_on INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  reminded_on TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE admins (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  added_by INTEGER,
  added_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  at TEXT NOT NULL
);

CREATE TABLE user_state (
  user_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_chat_id INTEGER NOT NULL,
  from_message_id INTEGER NOT NULL,
  preview TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','done','deleting','deleted')),
  status_chat_id INTEGER,
  status_msg_id INTEGER
);

CREATE TABLE broadcast_messages (
  broadcast_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  error TEXT,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','sent','failed','delete_queued','deleted','delete_failed')),
  PRIMARY KEY (broadcast_id, chat_id)
);
