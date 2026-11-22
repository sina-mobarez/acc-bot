-- Our own bank accounts (toman). A bank's balance is never stored: it is the sum of the approved
-- toman payments tagged with it (RECEIVE adds, PAY takes away) plus its manual moves.
CREATE TABLE banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- A deposit (+) or withdrawal (-) with no client behind it: opening balance, fees, transfers.
CREATE TABLE bank_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL,
  amount TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX bank_moves_bank ON bank_moves (bank_id, id);

-- The bank a toman payment went into or came out of.
ALTER TABLE entries ADD COLUMN bank_id INTEGER;
CREATE INDEX entries_bank ON entries (bank_id) WHERE bank_id IS NOT NULL;
