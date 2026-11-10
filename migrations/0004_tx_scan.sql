-- Payments created from a scanned on-chain transaction (USDT on TRON or BSC).
ALTER TABLE entries ADD COLUMN tx_network TEXT;
ALTER TABLE entries ADD COLUMN tx_hash TEXT;
ALTER TABLE entries ADD COLUMN tx_json TEXT;

-- The duplicate guard: one live (pending/approved) entry per transaction. A rejected or
-- cancelled one leaves the index, so the hash can be scanned again.
CREATE UNIQUE INDEX entries_tx_active ON entries (tx_network, tx_hash)
  WHERE tx_hash IS NOT NULL AND status IN ('pending', 'approved');

-- A scan waiting for an admin to pick its deal (callback_data is too short to carry the hash).
CREATE TABLE tx_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('PAY','RECEIVE')),
  amount TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_id INTEGER NOT NULL,
  source_msg_id INTEGER,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used'))
);
