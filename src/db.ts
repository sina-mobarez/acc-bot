/** D1 data access: entries and their history, accounts, admins, settings, bot bookkeeping. */
import Decimal from "decimal.js";
import type { LedgerEntry } from "./ledger";
import "./money"; // applies the global decimal.js config
import type { Side, Trade } from "./trade";

export type Status = "pending" | "approved" | "rejected" | "cancelled";

export const dealCode = (id: number): string => `D-${String(id).padStart(5, "0")}`;

export interface Entry {
  id: number;
  chatId: number;
  code: string;
  trade: Trade;
  status: Status;
  batchId: string | null;
  linkedDealId: number | null;
  cardMsgId: number | null;
  joke: string | null;
  createdBy: string;
  createdById: number;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
}

export interface NewEntry {
  chatId: number;
  trade: Trade;
  rawText?: string;
  joke?: string | null;
  linkedDealId?: number | null;
  batchId?: string | null;
  status?: Status;
  sourceMsgId?: number | null;
  createdBy: string;
  createdById: number;
  createdAt: string;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const dec = (v: unknown): Decimal | null => (v === null || v === undefined ? null : new Decimal(String(v)));
const decText = (d: Decimal | null): string | null => (d === null ? null : d.toFixed());

function tradeFromRow(r: Row): Trade {
  return {
    side: r.kind as Side,
    amount: new Decimal(String(r.amount)),
    asset: String(r.asset),
    rate: dec(r.rate),
    note: String(r.note),
    tomanTotal: dec(r.toman_total),
  };
}

function entryFromRow(r: Row): Entry {
  const id = Number(r.id);
  return {
    id,
    chatId: Number(r.chat_id),
    code: dealCode(id),
    trade: tradeFromRow(r),
    status: r.status as Status,
    batchId: str(r.batch_id),
    linkedDealId: num(r.linked_deal_id),
    cardMsgId: num(r.card_msg_id),
    joke: str(r.joke),
    createdBy: String(r.created_by),
    createdById: Number(r.created_by_id),
    createdAt: String(r.created_at),
    decidedBy: str(r.decided_by),
    decidedAt: str(r.decided_at),
    cancelledBy: str(r.cancelled_by),
    cancelledAt: str(r.cancelled_at),
  };
}

const ledgerFromRow = (r: Row): LedgerEntry => ({
  id: Number(r.id),
  trade: tradeFromRow(r),
  linkedDealId: num(r.linked_deal_id),
});

export const tradeToJson = (t: Trade): string =>
  JSON.stringify({
    side: t.side,
    amount: t.amount.toFixed(),
    asset: t.asset,
    rate: decText(t.rate),
    note: t.note,
    tomanTotal: decText(t.tomanTotal),
  });

function assertTrade(t: Trade): void {
  if (t.tomanTotal !== null && t.rate === null) {
    throw new Error("entry with toman_total must have a rate");
  }
}

// --- entries ------------------------------------------------------------------

export async function createEntry(db: D1Database, e: NewEntry): Promise<Entry> {
  assertTrade(e.trade);
  const t = e.trade;
  const res = await db
    .prepare(
      `INSERT INTO entries (chat_id, kind, amount, asset, rate, toman_total, note, raw_text, joke,
         linked_deal_id, batch_id, status, source_msg_id, created_by, created_by_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.chatId, t.side, t.amount.toFixed(), t.asset, decText(t.rate), decText(t.tomanTotal), t.note,
      e.rawText ?? "", e.joke ?? null, e.linkedDealId ?? null, e.batchId ?? null, e.status ?? "pending",
      e.sourceMsgId ?? null, e.createdBy, e.createdById, e.createdAt,
    )
    .run();
  const entry = await getEntry(db, Number(res.meta.last_row_id));
  if (!entry) throw new Error("entry vanished after insert");
  return entry;
}

export async function getEntry(db: D1Database, id: number): Promise<Entry | null> {
  const r = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first<Row>();
  return r ? entryFromRow(r) : null;
}

/** Look up by `D-00012` (case-insensitive) within one chat. */
export async function getByCode(db: D1Database, chatId: number, code: string): Promise<Entry | null> {
  const m = /^D-?(\d+)$/i.exec(code.trim());
  if (!m) return null;
  const r = await db
    .prepare("SELECT * FROM entries WHERE id = ? AND chat_id = ?")
    .bind(Number(m[1]), chatId)
    .first<Row>();
  return r ? entryFromRow(r) : null;
}

export async function findByCardMessage(db: D1Database, chatId: number, msgId: number): Promise<Entry | null> {
  const r = await db
    .prepare("SELECT * FROM entries WHERE chat_id = ? AND card_msg_id = ?")
    .bind(chatId, msgId)
    .first<Row>();
  return r ? entryFromRow(r) : null;
}

export async function entriesInBatch(db: D1Database, batchId: string): Promise<Entry[]> {
  const { results } = await db
    .prepare("SELECT * FROM entries WHERE batch_id = ? ORDER BY id")
    .bind(batchId)
    .all<Row>();
  return results.map(entryFromRow);
}

export async function setCardMessage(db: D1Database, id: number, msgId: number): Promise<void> {
  await db.prepare("UPDATE entries SET card_msg_id = ? WHERE id = ?").bind(msgId, id).run();
}

export async function setBatch(db: D1Database, ids: number[], batchId: string): Promise<void> {
  if (!ids.length) return;
  await db.batch(ids.map((id) => db.prepare("UPDATE entries SET batch_id = ? WHERE id = ?").bind(batchId, id)));
}

export interface TransitionFields {
  decidedBy?: string;
  decidedAt?: string;
  cancelledBy?: string;
  cancelledAt?: string;
}

const TRANSITION_COLUMNS = new Map<keyof TransitionFields, string>([
  ["decidedBy", "decided_by"],
  ["decidedAt", "decided_at"],
  ["cancelledBy", "cancelled_by"],
  ["cancelledAt", "cancelled_at"],
]);

/**
 * Move entries `from` -> `to`; true only if every id changed (the double-tap guard).
 * One conditional UPDATE: it matches nothing unless all ids are currently in `from`,
 * so a partial batch can never be applied.
 */
export async function transition(
  db: D1Database,
  ids: number[],
  from: Status,
  to: Status,
  fields: TransitionFields = {},
): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (!unique.length) return false;
  const marks = unique.map(() => "?").join(",");
  const sets: string[] = ["status = ?"];
  const values: (string | number)[] = [to];
  for (const [key, col] of TRANSITION_COLUMNS) {
    const v = fields[key];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      values.push(v);
    }
  }
  const res = await db
    .prepare(
      `UPDATE entries SET ${sets.join(", ")}
       WHERE id IN (${marks}) AND status = ?
         AND (SELECT COUNT(*) FROM entries WHERE id IN (${marks}) AND status = ?) = ?`,
    )
    .bind(...values, ...unique, from, ...unique, from, unique.length)
    .run();
  return res.meta.changes === unique.length;
}

export async function recordEvent(
  db: D1Database,
  entryId: number,
  action: "edit" | "cancel",
  actor: string,
  at: string,
  before: Trade | null,
  after: Trade | null,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO entry_events (entry_id, action, actor, at, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(entryId, action, actor, at, before && tradeToJson(before), after && tradeToJson(after))
    .run();
}

export async function editEntry(
  db: D1Database,
  id: number,
  trade: Trade,
  actor: string,
  at: string,
): Promise<Entry> {
  assertTrade(trade);
  const before = await getEntry(db, id);
  if (!before) throw new Error(`entry ${id} not found`);
  await db.batch([
    db
      .prepare(
        "UPDATE entries SET kind = ?, amount = ?, asset = ?, rate = ?, toman_total = ?, note = ? WHERE id = ?",
      )
      .bind(trade.side, trade.amount.toFixed(), trade.asset, decText(trade.rate), decText(trade.tomanTotal), trade.note, id),
    db
      .prepare(
        "INSERT INTO entry_events (entry_id, action, actor, at, before_json, after_json) VALUES (?, 'edit', ?, ?, ?, ?)",
      )
      .bind(id, actor, at, tradeToJson(before.trade), tradeToJson(trade)),
  ]);
  const after = await getEntry(db, id);
  if (!after) throw new Error(`entry ${id} vanished after edit`);
  return after;
}

/**
 * Cancel one entry that is currently in `from`. The UPDATE and its audit event run in one
 * batch (a transaction); the event row is inserted only if the UPDATE changed a row.
 */
export async function cancelEntry(
  db: D1Database,
  id: number,
  from: Status,
  actor: string,
  at: string,
): Promise<boolean> {
  const [upd] = await db.batch([
    db
      .prepare(
        "UPDATE entries SET status = 'cancelled', cancelled_by = ?, cancelled_at = ? WHERE id = ? AND status = ?",
      )
      .bind(actor, at, id, from),
    db
      .prepare(
        `INSERT INTO entry_events (entry_id, action, actor, at, before_json, after_json)
         SELECT id, 'cancel', ?, ?,
           json_object('side', kind, 'amount', amount, 'asset', asset, 'rate', rate,
                       'note', note, 'tomanTotal', toman_total),
           NULL
         FROM entries WHERE id = ? AND changes() = 1`,
      )
      .bind(actor, at, id),
  ]);
  return upd.meta.changes === 1;
}

/** Detach approved payments from a (cancelled) deal; they fall back to FIFO. Returns how many. */
export async function unlinkPayments(db: D1Database, dealId: number): Promise<number> {
  const res = await db
    .prepare("UPDATE entries SET linked_deal_id = NULL WHERE linked_deal_id = ? AND status = 'approved'")
    .bind(dealId)
    .run();
  return res.meta.changes;
}

export async function recent(db: D1Database, chatId: number, limit: number): Promise<Entry[]> {
  const { results } = await db
    .prepare("SELECT * FROM entries WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
    .bind(chatId, limit)
    .all<Row>();
  return results.map(entryFromRow);
}

export async function approvedLedger(db: D1Database, chatId: number): Promise<LedgerEntry[]> {
  const { results } = await db
    .prepare("SELECT * FROM entries WHERE chat_id = ? AND status = 'approved' ORDER BY id")
    .bind(chatId)
    .all<Row>();
  return results.map(ledgerFromRow);
}

export async function allApprovedByChat(db: D1Database): Promise<Map<number, LedgerEntry[]>> {
  const { results } = await db.prepare("SELECT * FROM entries WHERE status = 'approved' ORDER BY id").all<Row>();
  const out = new Map<number, LedgerEntry[]>();
  for (const r of results) {
    const chatId = Number(r.chat_id);
    const list = out.get(chatId);
    if (list) list.push(ledgerFromRow(r));
    else out.set(chatId, [ledgerFromRow(r)]);
  }
  return out;
}

export interface EntryFilter {
  status?: Status;
  kind?: Side;
  chatId?: number;
  limit: number;
  before?: number; // entries with id < before (pagination)
}

export async function listEntries(db: D1Database, f: EntryFilter): Promise<Entry[]> {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (f.status !== undefined) {
    where.push("status = ?");
    values.push(f.status);
  }
  if (f.kind !== undefined) {
    where.push("kind = ?");
    values.push(f.kind);
  }
  if (f.chatId !== undefined) {
    where.push("chat_id = ?");
    values.push(f.chatId);
  }
  if (f.before !== undefined) {
    where.push("id < ?");
    values.push(f.before);
  }
  const sql = `SELECT * FROM entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...values, f.limit)
    .all<Row>();
  return results.map(entryFromRow);
}

// --- accounts -----------------------------------------------------------------

export interface Account {
  chatId: number;
  title: string;
  displayName: string | null;
  type: string;
  botStatus: string;
  remindersOn: boolean;
  humorOn: boolean;
  archived: boolean;
  remindedOn: string | null;
  updatedAt: string;
}

const ACTIVE_BOT_STATUSES = ["member", "administrator", "creator"];

const accountFromRow = (r: Row): Account => ({
  chatId: Number(r.chat_id),
  title: String(r.title),
  displayName: str(r.display_name),
  type: String(r.type),
  botStatus: String(r.bot_status),
  remindersOn: Number(r.reminders_on) === 1,
  humorOn: Number(r.humor_on) === 1,
  archived: Number(r.archived) === 1,
  remindedOn: str(r.reminded_on),
  updatedAt: String(r.updated_at),
});

export const accountName = (a: Pick<Account, "title" | "displayName">): string => a.displayName ?? a.title;

/**
 * Record a group as the bot sees it. Without `botStatus`, seeing the chat means the bot is a
 * member: a first insert gets 'member', an existing admin status is kept, and left/kicked revive.
 */
export async function upsertAccount(
  db: D1Database,
  a: { chatId: number; title: string; type: string; at: string; botStatus?: string },
): Promise<void> {
  if (a.botStatus === undefined) {
    await db
      .prepare(
        `INSERT INTO accounts (chat_id, title, type, bot_status, updated_at) VALUES (?, ?, ?, 'member', ?)
         ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title, type = excluded.type,
           updated_at = excluded.updated_at,
           bot_status = CASE WHEN accounts.bot_status IN ('left', 'kicked') THEN 'member' ELSE accounts.bot_status END`,
      )
      .bind(a.chatId, a.title, a.type, a.at)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO accounts (chat_id, title, type, bot_status, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title, type = excluded.type,
           bot_status = excluded.bot_status, updated_at = excluded.updated_at`,
      )
      .bind(a.chatId, a.title, a.type, a.botStatus, a.at)
      .run();
  }
}

export async function getAccount(db: D1Database, chatId: number): Promise<Account | null> {
  const r = await db.prepare("SELECT * FROM accounts WHERE chat_id = ?").bind(chatId).first<Row>();
  return r ? accountFromRow(r) : null;
}

export async function listAccounts(
  db: D1Database,
  opts: { activeOnly?: boolean; includeArchived?: boolean } = {},
): Promise<Account[]> {
  const where: string[] = [];
  const values: string[] = [];
  if (opts.activeOnly) {
    where.push(`bot_status IN (${ACTIVE_BOT_STATUSES.map(() => "?").join(",")})`);
    values.push(...ACTIVE_BOT_STATUSES);
  }
  if (!opts.includeArchived) where.push("archived = 0");
  const sql = `SELECT * FROM accounts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY COALESCE(display_name, title), chat_id`;
  const { results } = await db
    .prepare(sql)
    .bind(...values)
    .all<Row>();
  return results.map(accountFromRow);
}

export interface AccountPatch {
  title?: string;
  displayName?: string | null;
  type?: string;
  botStatus?: string;
  remindersOn?: boolean;
  humorOn?: boolean;
  archived?: boolean;
  remindedOn?: string | null;
  updatedAt?: string;
}

const ACCOUNT_COLUMNS = new Map<keyof AccountPatch, string>([
  ["title", "title"],
  ["displayName", "display_name"],
  ["type", "type"],
  ["botStatus", "bot_status"],
  ["remindersOn", "reminders_on"],
  ["humorOn", "humor_on"],
  ["archived", "archived"],
  ["remindedOn", "reminded_on"],
  ["updatedAt", "updated_at"],
]);

export async function updateAccount(db: D1Database, chatId: number, patch: AccountPatch): Promise<void> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, col] of ACCOUNT_COLUMNS) {
    const v = patch[key];
    if (v === undefined) continue;
    sets.push(`${col} = ?`);
    values.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return;
  await db
    .prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE chat_id = ?`)
    .bind(...values, chatId)
    .run();
}

/** A group upgraded to a supergroup gets a new id; carry its records over. */
export async function migrateChat(db: D1Database, from: number, to: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE entries SET chat_id = ? WHERE chat_id = ?").bind(to, from),
    db.prepare("UPDATE pending_actions SET chat_id = ? WHERE chat_id = ?").bind(to, from),
    db.prepare("UPDATE OR REPLACE broadcast_messages SET chat_id = ? WHERE chat_id = ?").bind(to, from),
    db
      .prepare("DELETE FROM accounts WHERE chat_id = ? AND EXISTS (SELECT 1 FROM accounts WHERE chat_id = ?)")
      .bind(to, from),
    db.prepare("UPDATE accounts SET chat_id = ? WHERE chat_id = ?").bind(to, from),
  ]);
}

// --- admins -------------------------------------------------------------------

export interface Admin {
  userId: number;
  name: string;
  addedBy: number | null;
  addedAt: string;
}

/** Parse the comma-separated ADMIN_IDS secret (unset or empty means no env admins). */
export const parseAdminIds = (raw: string | undefined): Set<number> =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^-?\d+$/.test(s))
      .map(Number),
  );

export async function isAdmin(db: D1Database, adminIds: ReadonlySet<number>, userId: number): Promise<boolean> {
  if (adminIds.has(userId)) return true;
  return (await db.prepare("SELECT 1 AS x FROM admins WHERE user_id = ?").bind(userId).first()) !== null;
}

export async function listAdmins(db: D1Database): Promise<Admin[]> {
  const { results } = await db.prepare("SELECT * FROM admins ORDER BY added_at, user_id").all<Row>();
  return results.map((r) => ({
    userId: Number(r.user_id),
    name: String(r.name),
    addedBy: num(r.added_by),
    addedAt: String(r.added_at),
  }));
}

export async function addAdmin(
  db: D1Database,
  userId: number,
  name: string,
  addedBy: number | null,
  at: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admins (user_id, name, added_by, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET name = excluded.name`,
    )
    .bind(userId, name, addedBy, at)
    .run();
}

export async function removeAdmin(db: D1Database, userId: number): Promise<boolean> {
  const res = await db.prepare("DELETE FROM admins WHERE user_id = ?").bind(userId).run();
  return res.meta.changes === 1;
}

// --- settings, updates, user state, pending actions -----------------------------

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r ? r.value : null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

/** True if this update id is new (and is now recorded); false for a replay. */
export async function markUpdateSeen(db: D1Database, updateId: number, at: string): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO processed_updates (update_id, at) VALUES (?, ?)")
    .bind(updateId, at)
    .run();
  return res.meta.changes === 1;
}

export async function pruneUpdates(db: D1Database, olderThan: string): Promise<void> {
  await db.prepare("DELETE FROM processed_updates WHERE at < ?").bind(olderThan).run();
}

export interface UserState {
  state: string;
  data: unknown;
}

export async function getUserState(db: D1Database, userId: number): Promise<UserState | null> {
  const r = await db.prepare("SELECT state, data_json FROM user_state WHERE user_id = ?").bind(userId).first<Row>();
  return r ? { state: String(r.state), data: JSON.parse(String(r.data_json)) } : null;
}

export async function setUserState(
  db: D1Database,
  userId: number,
  state: string,
  data: unknown,
  at: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_state (user_id, state, data_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, state, JSON.stringify(data ?? {}), at)
    .run();
}

export async function clearUserState(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM user_state WHERE user_id = ?").bind(userId).run();
}

/** The changes an edit proposal asks for. Stored instead of a full trade so an older proposal never reverts newer edits. */
export interface EditChanges {
  amount?: Decimal;
  rate?: Decimal;
  note?: string;
}

export const editPayload = (ch: EditChanges): Record<string, string> => {
  const out: Record<string, string> = {};
  if (ch.amount !== undefined) out.amount = ch.amount.toFixed();
  if (ch.rate !== undefined) out.rate = ch.rate.toFixed();
  if (ch.note !== undefined) out.note = ch.note;
  return out;
};

export function editChangesFromPayload(p: unknown): EditChanges {
  const ch: EditChanges = {};
  if (typeof p !== "object" || p === null) return ch;
  const o = p as Record<string, unknown>;
  const has = (k: string) => Object.hasOwn(o, k) && o[k] !== null && o[k] !== undefined;
  if (has("amount")) ch.amount = new Decimal(String(o.amount));
  if (has("rate")) ch.rate = new Decimal(String(o.rate));
  if (has("note")) ch.note = String(o.note);
  return ch;
}

export interface PendingAction {
  id: number;
  chatId: number;
  kind: "edit";
  entryId: number;
  payload: unknown;
  createdBy: number;
  createdAt: string;
  status: "pending" | "applied" | "discarded";
}

const pendingFromRow = (r: Row): PendingAction => ({
  id: Number(r.id),
  chatId: Number(r.chat_id),
  kind: r.kind as "edit",
  entryId: Number(r.entry_id),
  payload: JSON.parse(String(r.payload_json)),
  createdBy: Number(r.created_by),
  createdAt: String(r.created_at),
  status: r.status as PendingAction["status"],
});

export async function createPendingAction(
  db: D1Database,
  a: { chatId: number; kind: "edit"; entryId: number; payload: unknown; createdBy: number; createdAt: string },
): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO pending_actions (chat_id, kind, entry_id, payload_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(a.chatId, a.kind, a.entryId, JSON.stringify(a.payload), a.createdBy, a.createdAt)
    .run();
  return Number(res.meta.last_row_id);
}

export async function getPendingAction(db: D1Database, id: number): Promise<PendingAction | null> {
  const r = await db.prepare("SELECT * FROM pending_actions WHERE id = ?").bind(id).first<Row>();
  return r ? pendingFromRow(r) : null;
}

/** Undo a claim whose follow-up work failed, so the button can be pressed again. */
export async function releasePendingAction(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE pending_actions SET status = 'pending' WHERE id = ? AND status = 'applied'").bind(id).run();
}

/** Atomically claim a pending action (compare-and-set on status); null if already taken. */
export async function takePendingAction(
  db: D1Database,
  id: number,
  to: "applied" | "discarded",
): Promise<PendingAction | null> {
  const r = await db
    .prepare("UPDATE pending_actions SET status = ? WHERE id = ? AND status = 'pending' RETURNING *")
    .bind(to, id)
    .first<Row>();
  return r ? pendingFromRow(r) : null;
}

// --- broadcasts -----------------------------------------------------------------

export type BroadcastStatus = "sending" | "done" | "deleting" | "deleted";

export interface Broadcast {
  id: number;
  fromChatId: number;
  fromMessageId: number;
  preview: string;
  createdBy: string;
  createdById: number;
  createdAt: string;
  status: BroadcastStatus;
  statusChatId: number | null;
  statusMsgId: number | null;
}

const broadcastFromRow = (r: Row): Broadcast => ({
  id: Number(r.id),
  fromChatId: Number(r.from_chat_id),
  fromMessageId: Number(r.from_message_id),
  preview: String(r.preview),
  createdBy: String(r.created_by),
  createdById: Number(r.created_by_id),
  createdAt: String(r.created_at),
  status: String(r.status) as BroadcastStatus,
  statusChatId: num(r.status_chat_id),
  statusMsgId: num(r.status_msg_id),
});

/** A new broadcast (status 'sending') with a queued row for every active, non-archived account. */
export async function createBroadcast(
  db: D1Database,
  b: {
    fromChatId: number;
    fromMessageId: number;
    preview: string;
    createdBy: string;
    createdById: number;
    createdAt: string;
    statusChatId: number;
    statusMsgId: number;
  },
): Promise<{ id: number; recipients: number }> {
  const res = await db
    .prepare(
      `INSERT INTO broadcasts (from_chat_id, from_message_id, preview, created_by, created_by_id, created_at,
         status_chat_id, status_msg_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(b.fromChatId, b.fromMessageId, b.preview, b.createdBy, b.createdById, b.createdAt, b.statusChatId, b.statusMsgId)
    .run();
  const id = Number(res.meta.last_row_id);
  const q = await db
    .prepare(
      `INSERT INTO broadcast_messages (broadcast_id, chat_id)
       SELECT ?, chat_id FROM accounts
       WHERE bot_status IN (${ACTIVE_BOT_STATUSES.map(() => "?").join(",")}) AND archived = 0`,
    )
    .bind(id, ...ACTIVE_BOT_STATUSES)
    .run();
  return { id, recipients: q.meta.changes };
}

export async function getBroadcast(db: D1Database, id: number): Promise<Broadcast | null> {
  const r = await db.prepare("SELECT * FROM broadcasts WHERE id = ?").bind(id).first<Row>();
  return r ? broadcastFromRow(r) : null;
}

export interface BroadcastWork {
  broadcastId: number;
  chatId: number;
  messageId: number | null;
  state: "queued" | "delete_queued";
  fromChatId: number;
  fromMessageId: number;
}

/** True if some broadcast is still sending or deleting (only then is there queue work). */
export async function hasActiveBroadcast(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM broadcasts WHERE status IN ('sending', 'deleting') LIMIT 1").first();
  return r !== null;
}

/** Oldest-first rows still to copy or delete, across broadcasts. */
export async function nextBroadcastWork(db: D1Database, limit: number): Promise<BroadcastWork[]> {
  const { results } = await db
    .prepare(
      `SELECT m.broadcast_id, m.chat_id, m.message_id, m.state, b.from_chat_id, b.from_message_id
       FROM broadcast_messages m JOIN broadcasts b ON b.id = m.broadcast_id
       WHERE m.state IN ('queued', 'delete_queued')
       ORDER BY m.broadcast_id, m.rowid LIMIT ?`,
    )
    .bind(limit)
    .all<Row>();
  return results.map((r) => ({
    broadcastId: Number(r.broadcast_id),
    chatId: Number(r.chat_id),
    messageId: num(r.message_id),
    state: String(r.state) as BroadcastWork["state"],
    fromChatId: Number(r.from_chat_id),
    fromMessageId: Number(r.from_message_id),
  }));
}

export interface Delivery {
  broadcastId: number;
  chatId: number;
  to: "sent" | "failed" | "deleted" | "delete_failed";
  messageId?: number;
  error?: string;
}

/** Rows per upsert statement: 5 bound parameters each stay under D1's cap of 100. */
export const DELIVERIES_PER_STATEMENT = 15;

/**
 * Record outcomes of queued/delete_queued rows in as few statements as possible
 * (ceil(n / DELIVERIES_PER_STATEMENT)). Rows that already left the queue are not touched.
 */
export async function recordDeliveries(db: D1Database, rows: Delivery[]): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += DELIVERIES_PER_STATEMENT) {
    const chunk = rows.slice(i, i + DELIVERIES_PER_STATEMENT);
    statements.push(
      db
        .prepare(
          `INSERT INTO broadcast_messages (broadcast_id, chat_id, message_id, error, state)
           VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}
           ON CONFLICT (broadcast_id, chat_id) DO UPDATE SET state = excluded.state,
             message_id = COALESCE(excluded.message_id, broadcast_messages.message_id), error = excluded.error
           WHERE broadcast_messages.state IN ('queued', 'delete_queued')`,
        )
        .bind(...chunk.flatMap((d) => [d.broadcastId, d.chatId, d.messageId ?? null, d.error ?? null, d.to])),
    );
  }
  if (statements.length) await db.batch(statements);
}

/** Broadcasts whose queue has drained: 'sending' with nothing queued, 'deleting' with nothing to delete. */
export async function drainedBroadcasts(db: D1Database): Promise<Broadcast[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM broadcasts b
       WHERE (b.status = 'sending' AND NOT EXISTS
                (SELECT 1 FROM broadcast_messages m WHERE m.broadcast_id = b.id AND m.state = 'queued'))
          OR (b.status = 'deleting' AND NOT EXISTS
                (SELECT 1 FROM broadcast_messages m WHERE m.broadcast_id = b.id AND m.state = 'delete_queued'))
       ORDER BY b.id`,
    )
    .all<Row>();
  return results.map(broadcastFromRow);
}

/** Compare-and-set a broadcast's status; true if it applied. */
export async function setBroadcastStatus(
  db: D1Database,
  id: number,
  from: BroadcastStatus,
  to: BroadcastStatus,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE broadcasts SET status = ? WHERE id = ? AND status = ?")
    .bind(to, id, from)
    .run();
  return res.meta.changes === 1;
}

/** done -> deleting, queueing every delivered copy for deletion (atomic). False if not 'done'. */
export async function startBroadcastDelete(db: D1Database, id: number, at: string): Promise<boolean> {
  const [, res] = await db.batch([
    db
      .prepare(
        `UPDATE broadcast_messages SET state = 'delete_queued'
         WHERE broadcast_id = ? AND state = 'sent'
           AND EXISTS (SELECT 1 FROM broadcasts WHERE id = ? AND status = 'done')`,
      )
      .bind(id, id),
    db
      .prepare("UPDATE broadcasts SET status = 'deleting', deleted_at = ? WHERE id = ? AND status = 'done'")
      .bind(at, id),
  ]);
  return res.meta.changes === 1;
}

export interface BroadcastReport {
  total: number;
  sent: number;
  deleted: number;
  deleteFailed: number;
  failed: { title: string; error: string }[];
}

export async function broadcastReport(db: D1Database, id: number): Promise<BroadcastReport> {
  const c = await db
    .prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(message_id IS NOT NULL), 0) AS sent,
         COALESCE(SUM(state = 'deleted'), 0) AS deleted,
         COALESCE(SUM(state = 'delete_failed'), 0) AS delete_failed
       FROM broadcast_messages WHERE broadcast_id = ?`,
    )
    .bind(id)
    .first<Row>();
  const { results } = await db
    .prepare(
      `SELECT COALESCE(a.display_name, a.title, CAST(m.chat_id AS TEXT)) AS title, COALESCE(m.error, '') AS error
       FROM broadcast_messages m LEFT JOIN accounts a ON a.chat_id = m.chat_id
       WHERE m.broadcast_id = ? AND m.state = 'failed' ORDER BY m.rowid LIMIT 20`,
    )
    .bind(id)
    .all<Row>();
  return {
    total: Number(c?.total ?? 0),
    sent: Number(c?.sent ?? 0),
    deleted: Number(c?.deleted ?? 0),
    deleteFailed: Number(c?.delete_failed ?? 0),
    failed: results.map((r) => ({ title: String(r.title), error: String(r.error) })),
  };
}

/** Delete the user's state only if it is `state`, returning its data (null if absent/different). */
export async function takeUserState(db: D1Database, userId: number, state: string): Promise<unknown | null> {
  const r = await db
    .prepare("DELETE FROM user_state WHERE user_id = ? AND state = ? RETURNING data_json")
    .bind(userId, state)
    .first<Row>();
  return r ? (JSON.parse(String(r.data_json)) ?? {}) : null;
}
