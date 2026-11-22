-- A reference typed in for a payment or deal: the bank tracking code (کد پیگیری) of a toman
-- payment, or the transaction hash of a crypto one that was not scanned on chain.
ALTER TABLE entries ADD COLUMN ref TEXT;

-- A payment an admin dictated without its reference: nothing is recorded until they reply to
-- the bot's question (ask_msg_id) with the tracking code or hash.
CREATE TABLE payment_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  ask_msg_id INTEGER,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used'))
);
CREATE INDEX payment_drafts_ask ON payment_drafts (chat_id, ask_msg_id);
