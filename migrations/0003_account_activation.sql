-- A group is a client account only once an admin has spoken (or acted) in it; until then the bot
-- stays silent there and it is left out of reminders, broadcasts, /groups and the Mini App.
ALTER TABLE accounts ADD COLUMN activated INTEGER NOT NULL DEFAULT 0;

-- Groups that already have entries were set up by an admin (only admins create entries).
UPDATE accounts SET activated = 1 WHERE chat_id IN (SELECT DISTINCT chat_id FROM entries);
