/** The Mini App's admin JSON API. Every route needs `Authorization: tma <initData>` from an admin. */
import Decimal from "decimal.js";
import type { App } from "../app";
import { entryKeyboard, renderEntry } from "../cards";
import {
  type Account, accountName, addAdmin, allApprovedByChat, approvedLedger, createEntry, deleteAccount, deleteEntry, editEntry, type Entry,
  getAccount, getEntry, getSetting, isAdmin, listAccounts, listAdmins, listEntries, recent, removeAdmin,
  setSetting, type Status, transition, updateAccount,
} from "../db";
import {
  cancelApproved, cancelPending, decideEntry, notifyChange, STALE_SETTLEMENT, UNLINKED_NOTE,
} from "../handlers/callback";
import { DEFAULT_DEVIATION_PCT, expandRateShorthand, parseDeviationSetting } from "../intent";
import { debts, type Leg, type LedgerEntry, openDeals, summarize } from "../ledger";
import { assetCode, normalize, parseAmountText, TOMAN } from "../money";
import { applyTradeEdit } from "../parser";
import { fetchUsdtToman, type UsdtPrice } from "../prices";
import { TgError } from "../telegram";
import { isPayment, type Side, type Trade } from "../trade";
import { validateInitData } from "./auth";
import { setAdminMenuButton } from "./menu";

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const bad = (message: string) => new ApiError(400, message);
const notFound = (message = "پیدا نشد.") => new ApiError(404, message);
const conflict = (message: string) => new ApiError(409, message);

type Body = Record<string, unknown>;
const STATUSES = new Set<string>(["pending", "approved", "rejected", "cancelled"]);
const SIDES = new Set<string>(["BUY", "SELL", "PAY", "RECEIVE"]);

// --- serialisation: money is always a string ------------------------------------

const money = (m: Map<string, Decimal>): Record<string, string> =>
  Object.fromEntries([...m.entries()].filter(([, v]) => !v.isZero()).map(([a, v]) => [a, v.toFixed()]));

const owedOf = (ledger: LedgerEntry[] | undefined): Map<string, Decimal> =>
  summarize((ledger ?? []).map((l) => l.trade)).owed;

const entryJson = (e: Entry) => ({
  id: e.id,
  code: e.code,
  chatId: e.chatId,
  kind: e.trade.side,
  amount: e.trade.amount.toFixed(),
  asset: e.trade.asset,
  rate: e.trade.rate?.toFixed() ?? null,
  tomanTotal: e.trade.tomanTotal?.toFixed() ?? null,
  note: e.trade.note,
  status: e.status,
  batchId: e.batchId,
  linkedDealId: e.linkedDealId,
  cardMsgId: e.cardMsgId,
  createdBy: e.createdBy,
  createdAt: e.createdAt,
  decidedBy: e.decidedBy,
  decidedAt: e.decidedAt,
  cancelledBy: e.cancelledBy,
  cancelledAt: e.cancelledAt,
});

const accountJson = (a: Account, owed: Map<string, Decimal>) => ({
  chatId: a.chatId,
  name: accountName(a),
  title: a.title,
  display_name: a.displayName,
  type: a.type,
  botStatus: a.botStatus,
  reminders_on: a.remindersOn,
  humor_on: a.humorOn,
  archived: a.archived,
  owed: money(owed),
});

const legJson = (l: Leg) => ({
  asset: l.asset, dir: l.dir, total: l.total.toFixed(), remaining: l.remaining.toFixed(),
});

const usdtJson = (p: UsdtPrice | null) =>
  p && { latest: p.latest.toFixed(), bestBuy: p.bestBuy.toFixed(), bestSell: p.bestSell.toFixed() };

// --- input parsing ----------------------------------------------------------------

async function bodyOf(req: Request): Promise<Body> {
  let b: unknown;
  try {
    b = await req.json();
  } catch {
    throw bad("بدنه‌ی درخواست JSON معتبر نیست.");
  }
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw bad("بدنه‌ی درخواست JSON معتبر نیست.");
  return b as Body;
}

function intOf(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw bad(`${what} نامعتبر است.`);
  return n;
}

function positiveAmount(v: unknown, what: string): Decimal {
  const d = typeof v === "string" || typeof v === "number" ? parseAmountText(String(v)) : null;
  if (d === null || !d.gt(0)) throw bad(`${what} نامعتبر است.`);
  return d;
}

const text = (v: unknown, what: string, max = 500): string => {
  if (typeof v !== "string") throw bad(`${what} نامعتبر است.`);
  const s = v.trim();
  if (s.length > max) throw bad(`${what} نامعتبر است.`);
  return s;
};

const flag = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw bad(`${what} نامعتبر است.`);
  return v;
};

// --- helpers shared by routes -------------------------------------------------------

async function entryOrThrow(app: App, id: number): Promise<Entry> {
  const e = await getEntry(app.db, id);
  if (!e) throw notFound("این مورد پیدا نشد.");
  return e;
}

/** Re-render the group card of an entry, if it has one. Telegram failures are not the API's failure. */
async function refreshCard(app: App, id: number): Promise<Entry> {
  const e = await entryOrThrow(app, id);
  if (e.cardMsgId !== null) {
    try {
      await app.tg.call("editMessageText", {
        chat_id: e.chatId,
        message_id: e.cardMsgId,
        text: renderEntry(e),
        parse_mode: "HTML",
        reply_markup: entryKeyboard(e) ?? { inline_keyboard: [] },
      });
    } catch (err) {
      if (!(err instanceof TgError)) throw err;
    }
  }
  return e;
}

const panelNotice = (e: Entry, title: string, extra = ""): string =>
  `${title}\n\n${renderEntry(e)}${extra ? `\n\n${extra}` : ""}`;

// --- routes ---------------------------------------------------------------------------

interface Ctx {
  app: App;
  req: Request;
  url: URL;
  actor: { id: number; name: string };
}

async function dashboard({ app }: Ctx) {
  const today = app.now().slice(0, 10);
  const [usdt, byChat, accounts, volumeRows, pending] = await Promise.all([
    fetchUsdtToman(app.fetch),
    allApprovedByChat(app.db),
    listAccounts(app.db, { includeArchived: true }),
    app.db
      .prepare(
        `SELECT amount FROM entries WHERE status = 'approved' AND asset = 'USDT'
           AND kind IN ('BUY','SELL') AND created_at LIKE ?`,
      )
      .bind(`${today}%`)
      .all<{ amount: string }>(),
    app.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE status = 'pending'").first<{ n: number }>(),
  ]);
  const receivable = new Map<string, Decimal>();
  const payable = new Map<string, Decimal>();
  const debtors: { chatId: number; name: string; owed: Map<string, Decimal> }[] = [];
  const names = new Map(accounts.map((a) => [a.chatId, accountName(a)]));
  for (const [chatId, ledger] of byChat) {
    const owed = owedOf(ledger);
    let owesUs = false;
    for (const [asset, v] of owed) {
      const into = v.gt(0) ? receivable : payable;
      if (v.isZero()) continue;
      into.set(asset, (into.get(asset) ?? new Decimal(0)).plus(v.abs()));
      if (v.gt(0)) owesUs = true;
    }
    if (owesUs) debtors.push({ chatId, name: names.get(chatId) ?? String(chatId), owed });
  }
  const at = (m: Map<string, Decimal>, a: string) => m.get(a) ?? new Decimal(0);
  debtors.sort((a, b) => at(b.owed, TOMAN).cmp(at(a.owed, TOMAN)) || at(b.owed, "USDT").cmp(at(a.owed, "USDT")));
  return {
    usdt: usdtJson(usdt),
    receivable: money(receivable),
    payable: money(payable),
    todayVolumeUsdt: volumeRows.results.reduce((s, r) => s.plus(r.amount), new Decimal(0)).toFixed(),
    pendingCount: Number(pending?.n ?? 0),
    topDebtors: debtors.slice(0, 5).map((d) => ({ chatId: d.chatId, name: d.name, owed: money(d.owed) })),
  };
}

async function accountsList({ app, url }: Ctx) {
  const [accounts, byChat] = await Promise.all([
    listAccounts(app.db, { includeArchived: url.searchParams.get("archived") === "1" }),
    allApprovedByChat(app.db),
  ]);
  return { accounts: accounts.map((a) => accountJson(a, owedOf(byChat.get(a.chatId)))) };
}

async function accountOrThrow(app: App, chatId: number): Promise<Account> {
  const a = await getAccount(app.db, chatId);
  if (!a) throw notFound("این مشتری پیدا نشد.");
  return a;
}

async function accountDetail({ app }: Ctx, chatId: number) {
  const account = await accountOrThrow(app, chatId);
  const [ledger, entries] = await Promise.all([approvedLedger(app.db, chatId), recent(app.db, chatId, 100)]);
  const codes = new Map(entries.map((e) => [e.id, e.code]));
  return {
    account: accountJson(account, owedOf(ledger)),
    openDeals: openDeals(ledger).map((d) => ({
      id: d.id, code: codes.get(d.id) ?? `D-${String(d.id).padStart(5, "0")}`, legs: d.legs.map(legJson),
    })),
    entries: entries.map(entryJson),
  };
}

async function patchAccount({ app, req }: Ctx, chatId: number) {
  const b = await bodyOf(req);
  await accountOrThrow(app, chatId);
  const patch: Parameters<typeof updateAccount>[2] = {};
  if (b.display_name !== undefined) {
    if (b.display_name === null) patch.displayName = null;
    else patch.displayName = text(b.display_name, "نام", 100) || null;
  }
  if (b.reminders_on !== undefined) patch.remindersOn = flag(b.reminders_on, "reminders_on");
  if (b.humor_on !== undefined) patch.humorOn = flag(b.humor_on, "humor_on");
  if (b.archived !== undefined) patch.archived = flag(b.archived, "archived");
  if (Object.keys(patch).length === 0) throw bad("چیزی برای تغییر نیست.");
  patch.updatedAt = app.now();
  await updateAccount(app.db, chatId, patch);
  const [account, ledger] = await Promise.all([accountOrThrow(app, chatId), approvedLedger(app.db, chatId)]);
  return { account: accountJson(account, owedOf(ledger)) };
}

async function postPayment({ app, req, actor }: Ctx, chatId: number) {
  const b = await bodyOf(req);
  await accountOrThrow(app, chatId);
  if (b.direction !== "PAY" && b.direction !== "RECEIVE") throw bad("جهت پرداخت نامعتبر است.");
  const amount = positiveAmount(b.amount, "مبلغ");
  const asset =
    b.asset === undefined || b.asset === null || b.asset === ""
      ? TOMAN
      : assetCode(normalize(text(b.asset, "دارایی", 20)).trim().toLowerCase());
  if (!asset || /\s/.test(asset)) throw bad("دارایی نامعتبر است.");
  const note = b.note === undefined || b.note === null ? "" : text(b.note, "توضیحات");
  let linkedDealId: number | null = null;
  if (b.linkedDealId !== undefined && b.linkedDealId !== null) {
    linkedDealId = intOf(b.linkedDealId, "معامله");
    const deal = await getEntry(app.db, linkedDealId);
    if (!deal || deal.chatId !== chatId || isPayment(deal.trade) || deal.status !== "approved") {
      throw bad("معامله‌ی مرتبط نامعتبر است.");
    }
  }
  const trade: Trade = { side: b.direction as Side, amount, asset, rate: null, note, tomanTotal: null };
  const created = await createEntry(app.db, {
    chatId, trade, linkedDealId, createdBy: actor.name, createdById: actor.id, createdAt: app.now(),
  });
  // The admin using the panel is the approver.
  await transition(app.db, [created.id], "pending", "approved", { decidedBy: actor.name, decidedAt: app.now() });
  const entry = await entryOrThrow(app, created.id);
  await notifyChange(app, entry, panelNotice(entry, "📲 <b>ثبت از پنل مدیریت</b>"));
  return { entry: entryJson(entry) };
}

async function entriesList({ app, url }: Ctx) {
  const q = url.searchParams;
  const status = q.get("status");
  const kind = q.get("kind");
  if (status !== null && !STATUSES.has(status)) throw bad("وضعیت نامعتبر است.");
  if (kind !== null && !SIDES.has(kind)) throw bad("نوع نامعتبر است.");
  const limitRaw = q.get("limit");
  const limit = limitRaw === null ? 50 : Math.min(100, Math.max(1, intOf(limitRaw, "limit")));
  const entries = await listEntries(app.db, {
    status: (status as Status | null) ?? undefined,
    kind: (kind as Side | null) ?? undefined,
    chatId: q.get("chatId") === null ? undefined : intOf(q.get("chatId"), "chatId"),
    before: q.get("before") === null ? undefined : intOf(q.get("before"), "before"),
    limit,
  });
  return { entries: entries.map(entryJson) };
}

async function decide({ app, actor }: Ctx, id: number, to: "approved" | "rejected") {
  const entry = await entryOrThrow(app, id);
  const r = await decideEntry(app, entry, to, actor.name);
  if (r === "already") throw conflict("این مورد قبلاً بررسی شده است.");
  const fresh = await refreshCard(app, id);
  if (fresh.cardMsgId === null) {
    const title =
      r === "stale"
        ? "❌ <b>تسویه منقضی بود و از پنل مدیریت رد شد</b>"
        : to === "approved"
          ? "✅ <b>تایید از پنل مدیریت</b>"
          : "❌ <b>رد از پنل مدیریت</b>";
    await notifyChange(app, fresh, panelNotice(fresh, title));
  }
  if (r === "stale") throw conflict(STALE_SETTLEMENT);
  return { entry: entryJson(fresh) };
}

async function cancel({ app, actor }: Ctx, id: number) {
  const entry = await entryOrThrow(app, id);
  let note = "";
  if (entry.status === "approved") {
    const r = await cancelApproved(app, entry, actor.name);
    if (!r.ok) throw conflict("این مورد قبلاً بررسی شده است.");
    if (r.unlinked > 0) note = `ℹ️ ${UNLINKED_NOTE}`;
  } else if (entry.status === "pending") {
    if (!(await cancelPending(app, entry, actor.name))) throw conflict("این مورد قبلاً بررسی شده است.");
  } else {
    throw conflict("این مورد قبلاً بررسی شده است.");
  }
  const fresh = await refreshCard(app, id);
  await notifyChange(app, fresh, panelNotice(fresh, "🚫 <b>لغو از پنل مدیریت</b>", note));
  return { entry: entryJson(fresh), unlinked: note !== "" };
}

const DELETED_CARD = "🗑 این مورد از پنل مدیریت حذف شد";

async function removeEntry({ app }: Ctx, id: number) {
  const gone = await deleteEntry(app.db, id);
  if (!gone) throw notFound("این مورد پیدا نشد.");
  if (gone.cardMsgId !== null) {
    try {
      await app.tg.call("editMessageText", { chat_id: gone.chatId, message_id: gone.cardMsgId, text: DELETED_CARD });
    } catch (err) {
      if (!(err instanceof TgError)) throw err;
    }
  }
  return { ok: true };
}

async function removeAccount({ app }: Ctx, chatId: number) {
  if (!(await deleteAccount(app.db, chatId))) throw notFound("این مشتری پیدا نشد.");
  return { ok: true };
}

async function patchEntry({ app, req, actor }: Ctx, id: number) {
  const b = await bodyOf(req);
  const cur = await entryOrThrow(app, id);
  if (cur.status !== "pending" && cur.status !== "approved") throw conflict("این مورد دیگر قابل ویرایش نیست.");
  const ch: { amount?: Decimal; rate?: Decimal; note?: string } = {};
  if (b.amount !== undefined) ch.amount = positiveAmount(b.amount, "مبلغ");
  if (b.rate !== undefined) {
    if (isPayment(cur.trade)) throw bad("پرداخت قیمت ندارد؛ فقط مبلغ یا توضیح را می‌شود تغییر داد.");
    const raw = positiveAmount(b.rate, "قیمت");
    // Shorthand «۲۷۰» for 270,000 needs the live price, but only a small USDT rate can be shorthand.
    const ref = cur.trade.asset === "USDT" && raw.lt(10000) ? (await fetchUsdtToman(app.fetch))?.latest ?? null : null;
    ch.rate = expandRateShorthand(raw, cur.trade.asset, ref);
  }
  if (b.note !== undefined) ch.note = b.note === null ? "" : text(b.note, "توضیحات");
  if (Object.keys(ch).length === 0) throw bad("چیزی برای تغییر نیست.");
  await editEntry(app.db, id, applyTradeEdit(cur.trade, ch), actor.name, app.now());
  const fresh = await refreshCard(app, id);
  await notifyChange(app, fresh, panelNotice(fresh, "✏️ <b>ویرایش از پنل مدیریت</b>"));
  return { entry: entryJson(fresh) };
}

async function adminsOf(app: App) {
  const stored = await listAdmins(app.db);
  const env = [...app.adminIds].map((userId) => ({ userId, name: "", removable: false, source: "env" }));
  const envIds = new Set(app.adminIds);
  return {
    admins: [
      ...env,
      ...stored.filter((a) => !envIds.has(a.userId)).map((a) => ({
        userId: a.userId, name: a.name, removable: true, source: "db",
      })),
    ],
  };
}

async function adminAdd({ app, req, actor }: Ctx) {
  const b = await bodyOf(req);
  const userId = intOf(b.userId, "شناسه");
  if (userId <= 0) throw bad("شناسه نامعتبر است.");
  const name = text(b.name ?? "", "نام", 100);
  await addAdmin(app.db, userId, name, actor.id, app.now());
  await setAdminMenuButton(app, userId); // best-effort: a failure never fails the API call
  return adminsOf(app);
}

async function adminRemove({ app, url }: Ctx, rawId: string | null) {
  const userId = intOf(rawId ?? url.searchParams.get("userId"), "شناسه");
  if (app.adminIds.has(userId)) throw bad("مدیر اصلی قابل حذف نیست.");
  if (!(await removeAdmin(app.db, userId))) throw notFound("این مدیر پیدا نشد.");
  return adminsOf(app);
}

async function settingsGet({ app }: Ctx) {
  const [dev, rem] = await Promise.all([getSetting(app.db, "deviation_pct"), getSetting(app.db, "reminders_default")]);
  return {
    deviation_pct: (parseDeviationSetting(dev) ?? new Decimal(DEFAULT_DEVIATION_PCT)).toFixed(),
    reminders_default: rem !== "0",
  };
}

/** Partial update: deviation_pct (positive decimal) and/or reminders_default (boolean, stored '1'/'0'). */
async function settingsPatch(c: Ctx) {
  const b = await bodyOf(c.req);
  let dev: Decimal | null = null;
  if (b.deviation_pct !== undefined) {
    const raw = b.deviation_pct;
    dev = typeof raw === "string" || typeof raw === "number" ? parseDeviationSetting(String(raw)) : null;
    if (dev === null) throw bad("درصد انحراف باید عددی مثبت باشد.");
  }
  const rem = b.reminders_default === undefined ? undefined : flag(b.reminders_default, "یادآوری پیش‌فرض");
  if (dev === null && rem === undefined) throw bad("چیزی برای تغییر نیست.");
  if (dev !== null) await setSetting(c.app.db, "deviation_pct", dev.toFixed());
  if (rem !== undefined) await setSetting(c.app.db, "reminders_default", rem ? "1" : "0");
  return settingsGet(c);
}

// --- dispatch ---------------------------------------------------------------------------

async function route(c: Ctx): Promise<unknown> {
  const { pathname } = c.url;
  const m = c.req.method;
  let r: RegExpExecArray | null;

  if (m === "GET" && pathname === "/api/dashboard") return dashboard(c);
  if (m === "GET" && pathname === "/api/accounts") return accountsList(c);
  if ((r = /^\/api\/accounts\/(-?\d+)$/.exec(pathname))) {
    if (m === "GET") return accountDetail(c, Number(r[1]));
    if (m === "PATCH") return patchAccount(c, Number(r[1]));
    if (m === "DELETE") return removeAccount(c, Number(r[1]));
  }
  if (m === "POST" && (r = /^\/api\/accounts\/(-?\d+)\/payments$/.exec(pathname))) return postPayment(c, Number(r[1]));
  if (m === "GET" && pathname === "/api/entries") return entriesList(c);
  if ((r = /^\/api\/entries\/(\d+)\/(approve|reject|cancel)$/.exec(pathname)) && m === "POST") {
    const id = Number(r[1]);
    if (r[2] === "cancel") return cancel(c, id);
    return decide(c, id, r[2] === "approve" ? "approved" : "rejected");
  }
  if ((r = /^\/api\/entries\/(\d+)$/.exec(pathname))) {
    if (m === "PATCH") return patchEntry(c, Number(r[1]));
    if (m === "DELETE") return removeEntry(c, Number(r[1]));
  }
  if (pathname === "/api/admins") {
    if (m === "GET") return adminsOf(c.app);
    if (m === "POST") return adminAdd(c);
    if (m === "DELETE") return adminRemove(c, null);
  }
  if (m === "DELETE" && (r = /^\/api\/admins\/(-?\d+)$/.exec(pathname))) return adminRemove(c, r[1]);
  if (pathname === "/api/settings") {
    if (m === "GET") return settingsGet(c);
    if (m === "PATCH") return settingsPatch(c);
  }
  throw notFound("مسیر پیدا نشد.");
}

const fail = (status: number, error: string) => Response.json({ error }, { status });

export async function handleApi(app: App, req: Request): Promise<Response> {
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("tma ")) return fail(401, "احراز هویت لازم است.");
  const actor = await validateInitData(header.slice(4), app.env.BOT_TOKEN, Math.floor(Date.now() / 1000));
  if (!actor) return fail(401, "احراز هویت نامعتبر است.");
  if (!(await isAdmin(app.db, app.adminIds, actor.id))) return fail(403, "فقط مدیران به این بخش دسترسی دارند.");
  try {
    return Response.json(await route({ app, req, url: new URL(req.url), actor }));
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.message);
    throw e;
  }
}
