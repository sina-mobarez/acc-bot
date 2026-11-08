-- The every-minute broadcast tick looks for queued work; keep that lookup off a full scan
-- of broadcast_messages (never pruned), and make the "anything active?" check on broadcasts cheap.
CREATE INDEX IF NOT EXISTS broadcast_messages_work ON broadcast_messages(state) WHERE state IN ('queued','delete_queued');
CREATE INDEX IF NOT EXISTS broadcasts_status ON broadcasts(status);
