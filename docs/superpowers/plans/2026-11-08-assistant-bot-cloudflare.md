# acc-bot v2 (Cloudflare assistant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite acc-bot as a TypeScript Cloudflare Worker. Admins talk to it in plain Persian (via mention or reply) to record trades, payments, settlements, edits and cancellations behind an approval card. Clients can ask about their account and live prices. The bot jokes with a bazaari tone, reminds debtors at 10:00 Tehran, and admins manage everything from a Telegram Mini App.

**Architecture:** One Worker serves three things:
- the Telegram webhook (`POST /tg`): ack immediately, process in `ctx.waitUntil`, dedupe by `update_id`,
- the Mini App JSON API (`/api/*`): auth by HMAC-validated `initData`,
- the static Mini App (`public/app/`, Workers static assets).

Data lives in D1. A one-minute cron runs the reminder and broadcast batches. Gemini only extracts fields into a JSON schema; all money math is our own `decimal.js` code, ported from the v1 Python parser and ledger. Every external dependency (Telegram, Gemini, price APIs, clock) is injected through an `App` object, so handlers are tested with fakes.

**Tech Stack:**
- TypeScript, Cloudflare Workers (Free plan), D1, Workers static assets, Cron Triggers
- `decimal.js`
- `@grammyjs/types` (types only; raw Bot API over `fetch`)
- Gemini REST `generateContent` with `responseSchema`
- Nobitex v2 and KuCoin public REST
- Vitest + `@cloudflare/vitest-pool-workers`
- Mini App frontend: plain HTML, CSS and ES modules plus `telegram-web-app.js`, no build step

**Spec:** `docs/superpowers/specs/2026-11-08-assistant-bot-cloudflare-design.md`. Read it before any task. v1 Python sources in `accbot/` are the porting reference until Task 15 deletes them; they stay in git history.

## Global Constraints

**User-facing text**
- All of it is Persian. Telegram messages use `parse_mode: "HTML"`, with every user-supplied string escaped.
- Persian digits are used for display (`fa()`).

**Data and money**
- Every money value is `Decimal` in memory and TEXT in D1. Never use JS `number` for amounts, rates or totals.
- The ledger sign convention matches v1 `accbot/ledger.py`: everything is from our side, and `owed > 0` means the client owes us.
  - BUY: client owes the asset, we owe toman.
  - SELL: the reverse.
  - PAY adds (`+`); RECEIVE subtracts (`−`).
- Toman's asset code is `IRT`. Asset-from-toman conversion rounds half-up to `PRECISION` places (USDT, USD, EUR, AED and TRY: 2; others: 8).
- Time is Asia/Tehran, fixed at UTC+03:30 with no DST. Timestamps are stored as ISO strings with `+03:30` and displayed as Jalali via `Intl.DateTimeFormat("fa-IR-u-ca-persian", {timeZone: "Asia/Tehran"})`.

**Permissions and safety**
- Nothing enters the ledger (status `approved`) without an admin pressing ✅ on a card or approving in the Mini App.
- Gemini never computes numbers. It returns the literal text the user wrote, and `parseAmountText` turns that into a `Decimal`.
- Admins are user IDs in the `ADMIN_IDS` secret (comma-separated) plus rows in the `admins` table. Telegram group-admin status grants nothing.
- A client only ever sees data for the chat they're writing in. The Mini App is admin-only.

**Humor and fallbacks**
- Joke hard lines, which go in the Gemini system prompt verbatim in meaning: never insult family, religion, ethnicity or physical appearance (beyond light money-teasing like «آخه تو قیافت به این پول می‌خوره؟»), and nothing sexual.
- A joke is one line, shown after the facts, and never replaces them.
- If Gemini fails (network error, 429, invalid JSON), the bot still answers. The `#` fast path works fully. Natural-language input gets `BUSY_TEXT`, which suggests the `#` form.
- If Nobitex fails, cards render without a price comparison and price queries say the price is unavailable.
- Price-gouging tease threshold: `deviation_pct` setting, default `3`.

**Free-plan limits**
- Stay under ~50 external subrequests per invocation. Fan-out batches send at most `BATCH_SIZE = 40` Telegram calls per invocation.
- No Gemini call per reminder. Nudge lines come from a fixed list.

**Configuration**
- Secrets (via `wrangler secret put`, never committed): `BOT_TOKEN`, `GEMINI_API_KEY`, `WEBHOOK_SECRET`, `ADMIN_IDS`.
- Vars in `wrangler.jsonc`: `GEMINI_MODEL` (default `"gemini-flash-latest"`; check the current fast Flash model id at build time) and `DEFAULT_ASSET` (`"USDT"`).
- Nobitex: `GET https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls`. The response's `stats["usdt-rls"]` values `latest`, `bestBuy` and `bestSell` are **rial strings**, so divide by 10 for toman.
- The deviation reference price is `latest`.
- KuCoin: `GET https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=<COIN>-USDT`. The price is `data.price`, and `data` is `null` for an unknown symbol.

## Review Focus

1. **Duplicate updates and double taps.** Telegram may resend an update (a slow ack) and an admin may tap ✅ twice. Expected: exactly one card per message and one approval per entry. Tests: Task 7 `duplicate update_id is processed once`; Task 9 `second approve is a no-op`.
2. **Gemini down, rate-limited or returning garbage.** Expected:
   - `#` messages still produce cards (with an ordinary line instead of a Gemini joke),
   - natural-language messages get `BUSY_TEXT`,
   - nothing crashes or goes silent.

   Tests: Task 6 `non-200 / bad JSON → failure`; Task 8 `gemini failure falls back`.
3. **A client trying to write, or asking about someone else.** Expected: the client's `#خرید …` or «ثبت کن…» is refused with a joke. A client asking «بدهی علی چقدره» in their own group only ever gets their own group's balance. Tests: Task 8 `client write is refused`, `client balance ignores client_hint`.
4. **Group renamed or upgraded to a supergroup.** The `migrate_to_chat_id` message and the `ChatMigrated` error (`parameters.migrate_to_chat_id`) both appear. Expected: entries, account settings and pending broadcast rows all move to the new chat id, and the title updates. Tests: Task 4 `migrateChat moves entries and account`; Task 7 `migrate message triggers migration`.
5. **Bot removed from a group mid-batch.** A 403 or `Forbidden` during a reminder or broadcast. Expected: the account is marked `left`, the batch continues with the next group, and the group isn't retried. Tests: Task 11 `403 marks left and continues`; Task 12 `failed delivery recorded, batch continues`.

---

## File Structure

```
package.json, tsconfig.json, wrangler.jsonc, vitest.config.ts, .dev.vars.example
migrations/0001_init.sql        D1 schema
src/index.ts                    fetch + scheduled entry; routing (/tg, /setup, /health/prices, /api/*)
src/app.ts                      App context type + createApp(env, ctx)
src/money.ts                    normalize, multipliers, parseAmountText, fmtNum, fa, asset tables
src/trade.ts                    Trade, Side, tradeTotal, isPayment
src/parser.ts                   '#' grammar (port of accbot/parser.py)
src/ledger.ts                   summarize (balances) + allocate (FIFO per-deal remaining)
src/db.ts                       all D1 queries (entries, events, accounts, admins, settings, updates, user_state)
src/telegram.ts                 Tg client, TgError, helpers
src/prices.ts                   Nobitex + KuCoin
src/nlu.ts                      Gemini client, schema, prompt
src/intent.ts                   NluOutput → Action (validation, role gate, rate shorthand, deviation)
src/cards.ts                    all HTML rendering + inline keyboards
src/jokes.ts                    fixed line sets + pick()
src/handlers/update.ts          handleUpdate: dedupe, tracking, trigger detection, dispatch
src/handlers/message.ts         natural-language / '#' messages → cards and answers
src/handlers/callback.ts        card buttons
src/handlers/commands.ts        /help /id /deals /balance /app /groups
src/broadcast.ts                /broadcast flow + batched sending/deleting
src/reminders.ts                daily reminder batch
src/cron.ts                     scheduled(): reminders, broadcast batches, pruning
src/miniapp/auth.ts             initData validation
src/miniapp/api.ts              /api/* routes
public/app/index.html, app.js, app.css
test/fakes.ts                   FakeTg, FakeNlu, fakeFetch, makeApp()
test/*.test.ts
```

`App` (in `src/app.ts`) is the single dependency bag every handler takes:

```ts
export interface App {
  env: Env;                      // bindings + vars + secrets
  db: D1Database;
  tg: Tg;
  nlu: Nlu;
  fetch: typeof fetch;           // for prices
  now(): string;                 // ISO, +03:30
  adminIds: Set<number>;         // parsed ADMIN_IDS
  defer(p: Promise<unknown>): void; // ctx.waitUntil in prod; collects promises in tests
}
```

---

### Task 1: Scaffold, prices, and the Nobitex-from-Cloudflare gate

The spec requires verifying Nobitex from a *deployed Worker* before building anything else.

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.dev.vars.example`, `src/index.ts`, `src/prices.ts`, `test/prices.test.ts`
- Modify: `.gitignore` (add `node_modules/`, `.wrangler/`, `.dev.vars`)

**Interfaces:**
- Produces:
  - `fetchUsdtToman(f: typeof fetch): Promise<UsdtPrice | null>`, where `UsdtPrice = { latest: Decimal; bestBuy: Decimal; bestSell: Decimal }` (toman)
  - `fetchCoinUsdt(coin: string, f: typeof fetch): Promise<Decimal | null>`
  - `quoteCoins(coins: string[], f: typeof fetch): Promise<CoinQuote[]>`, where `CoinQuote = { coin: string; usdt: Decimal | null; toman: Decimal | null }` and `toman = usdt × usdtToman.latest`. Upper-case the coin. USDT itself returns `usdt = 1`.
  - `GET /health/prices` → JSON `{ nobitex: string | null, kucoinBtc: string | null }`

- [ ] **Step 1: Scaffold the project.**
  - `npm init`, then install `wrangler`, `typescript`, `vitest`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, `@grammyjs/types` and `decimal.js`.
  - Configure `vitest.config.ts` for the workers pool with a D1 binding `DB` and migrations applied in a setup file. Follow the current `@cloudflare/vitest-pool-workers` docs for D1 migrations in tests.
  - `wrangler.jsonc`:
    - `name: "acc-bot"`, `main: "src/index.ts"`, the current `compatibility_date`
    - a `d1_databases` binding `DB`
    - `assets: { directory: "public", binding: "ASSETS" }`
    - `triggers.crons: ["* * * * *"]`
    - vars `GEMINI_MODEL`, `DEFAULT_ASSET`
  - `package.json` scripts:
    - `test`: `vitest run`
    - `dev`: `wrangler dev`
    - `deploy`: `wrangler deploy`
    - `db:migrate`: `wrangler d1 migrations apply acc-bot --remote`

- [ ] **Step 2: Write failing tests** in `test/prices.test.ts` with a fake `fetch` that returns fixtures:

```ts
test("nobitex rial → toman", async () => {
  const f = fakeFetch({ "apiv2.nobitex.ir": { status: "ok", stats: { "usdt-rls": { latest: "2660010", bestBuy: "2660000", bestSell: "2661320" } } } });
  const p = await fetchUsdtToman(f);
  expect(p!.latest.toString()).toBe("266001");
  expect(p!.bestSell.toString()).toBe("266132");
});
test("nobitex failure → null", async () => { expect(await fetchUsdtToman(fakeFetch({ "apiv2.nobitex.ir": 500 }))).toBeNull(); });
test("kucoin unknown symbol → null", async () => { expect(await fetchCoinUsdt("ZZZ", fakeFetch({ "api.kucoin.com": { code: "200000", data: null } }))).toBeNull(); });
test("quote converts to toman", async () => { /* BTC usdt 75929.2 × 266001 → toman 20197253839.2 */ });
```

  `fakeFetch(routes)` lives in `test/fakes.ts`. It matches by hostname; a number value means respond with that status; anything else is a JSON body.

- [ ] **Step 3: Run `npm test`.** Expected: FAIL (module missing).
- [ ] **Step 4: Implement `src/prices.ts`** and a minimal `src/index.ts` that serves `/health/prices` and returns 404 otherwise.
  - Use `fetch` with a 5 s `AbortSignal.timeout`.
  - Any non-200, non-`ok` or missing field returns `null`.
- [ ] **Step 5: Run `npm test`.** Expected: PASS.
- [ ] **Step 6: Gate (needs the owner).**
  - Ask the owner to run `! npx wrangler login`. Then create the DB with `npx wrangler d1 create acc-bot`, put its id in `wrangler.jsonc`, and run `npx wrangler deploy`.
  - Then run `curl https://acc-bot.<subdomain>.workers.dev/health/prices`.
  - Expected: `nobitex` is a number string near the current USDT price.
  - **If `nobitex` is null, STOP** and report to the owner. Don't switch sources (spec constraint).
- [ ] **Step 7: Commit** with message `feat: scaffold worker with live price fetching`.

### Task 2: Money helpers, Trade, and the `#` parser port

**Files:**
- Create: `src/money.ts`, `src/trade.ts`, `src/parser.ts`, `test/money.test.ts`, `test/parser.test.ts`

**Interfaces:**
- Produces from `money.ts`:
  - `normalize(s: string): string` (same table as v1 `_NORMALIZE`, ZWNJ → space)
  - `MULTIPLIERS`, `ASSETS`, `ASSET_NAMES`, `TOMAN = "IRT"`, `PRECISION`
  - `assetCode(word: string): string` (Persian name → code, else upper-cased)
  - `assetName(code)`
  - `parseAmountText(s: string): Decimal | null`: a number plus an optional multiplier word, e.g. «۲ میلیون», «275k», «۲۷۵ هزار», «2,500,000»; null for anything else
  - `fmtNum(d: Decimal): string`, `fa(v: Decimal | number | string): string`
- Produces from `trade.ts`:
  - `type Side = "BUY" | "SELL" | "PAY" | "RECEIVE"`
  - `interface Trade { side: Side; amount: Decimal; asset: string; rate: Decimal | null; note: string; tomanTotal: Decimal | null }`
  - `tradeTotal(t): Decimal | null` (same rule as v1 `Trade.total`), `isPayment(t)`, `byToman(t)`
- Produces from `parser.ts`:
  - `class TradeError extends Error` (message is Persian)
  - `parseTrade(text, defaultAsset = "USDT"): Trade | null`
  - `parsePayment(text): Trade | null`
  - `parseMessage(text, defaultAsset = "USDT"): Trade | null`

- [ ] **Step 1: Write failing tests.**
  - Port **every** case in v1 `tests/test_parser.py` into `test/parser.test.ts` with `test.each`, same inputs and expected values. That's 16 trade cases, 11 rejections, 6 payment cases, 6 toman-amount cases, the hashtag requirement, the no-price `TradeError`, and the note and total checks.
  - `test/money.test.ts` covers:
    - `parseAmountText("۲ میلیون") = 2000000`, `("۲۷۵ هزار") = 275000`, `("1.5m") = 1500000`, `("2,500,000") = 2500000`, `("سلام") = null`
    - `fmtNum(1500.50) = "1,500.5"`
    - `fa(27500000) = "۲۷٬۵۰۰٬۰۰۰"`
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Translate `TRADE_RE` and `PAYMENT_RE` from v1 `accbot/parser.py:56-77` into JS regexes with the `u` and `i` flags. Python `[^\W\d_]` becomes `[\p{L}]`.
  - Keep the "longer multiplier first" ordering.
  - `\b` doesn't work for Persian letters in JS. Use `(?=\s|$)` lookaheads wherever v1 used `\b` after a Persian word.
- [ ] **Step 4: Run `npm test`.** Expected: PASS (all ported cases).
- [ ] **Step 5: Commit** with message `feat: port money helpers and # parser to TypeScript`.

### Task 3: Ledger: balances and FIFO per-deal remaining

**Files:**
- Create: `src/ledger.ts`, `test/ledger.test.ts`

**Interfaces:**
- Consumes: `Trade`, `tradeTotal`, `isPayment`, `TOMAN`.
- Produces:
  - `summarize(trades: Trade[]): Account`
    - `Account = { owed: Map<string, Decimal>; trades: AssetStats[]; paid: Map; received: Map; unpriced: number; count: number }`
    - `AssetStats` mirrors v1 `AssetBalance`, with `avgBuy` and `avgSell` getters.
    - `debts(acc): [string, Decimal][]` (USDT, then IRT, then alphabetical).
  - `interface LedgerEntry { id: number; trade: Trade; linkedDealId: number | null }` (approved entries only, in id order).
  - `interface Leg { asset: string; dir: "client_owes" | "we_owe"; total: Decimal; remaining: Decimal }`
  - `allocate(entries: LedgerEntry[]): Map<number, Leg[]>`: per trade id, its legs after payments. A trade is *open* if any leg has `remaining > 0`.
  - `openDeals(entries): { id: number; legs: Leg[] }[]`: open trades, oldest first.

- [ ] **Step 1: Write failing tests.**
  - Port all six v1 `tests/test_ledger.py` cases for `summarize`.
  - Add `allocate` cases:
    - `SELL 100@300000` then `RECEIVE 10,000,000 IRT` gives the client_owes IRT leg `remaining 20,000,000` and the we_owe USDT leg `remaining 100`.
    - Two SELLs (ids 1, 2, each 10M toman) plus an unlinked `RECEIVE 15M` gives remaining `0` and `5M`. FIFO is oldest first.
    - A `RECEIVE 10M` linked to deal 2 is applied to deal 2 first, even though deal 1 is older.
    - A linked payment larger than its leg pays the leg to zero and the excess flows FIFO to the next open leg.
    - `PAY` reduces we_owe legs only, and `RECEIVE` reduces client_owes legs only.
    - An unpriced BUY has only the asset leg.
    - Overpayment beyond all legs leaves every leg at `0`; the excess shows only in `summarize`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** `summarize` is a direct port. `allocate` uses this algorithm:

```
legs: for each trade in id order —
  BUY a@r:  client_owes (asset, a); we_owe (IRT, total) if priced
  SELL a@r: we_owe (asset, a);      client_owes (IRT, total) if priced
payments in id order — RECEIVE → dir client_owes, PAY → dir we_owe; x = amount, asset = payment.asset
  if linkedDealId: take min(x, leg.remaining) from that deal's leg with same (asset, dir); x -= taken
  while x > 0: take from the oldest leg with same (asset, dir) and remaining > 0; stop if none
```

- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: ledger balances and FIFO deal allocation`.

### Task 4: D1 schema and data access

**Files:**
- Create: `migrations/0001_init.sql`, `src/db.ts`, `test/db.test.ts`

**Schema** (all money columns TEXT; all timestamps TEXT ISO):

| Table | Columns and notes |
|---|---|
| `entries` | `id` INTEGER PK AUTOINCREMENT, `chat_id`, `kind` (BUY/SELL/PAY/RECEIVE), `amount`, `asset`, `rate`, `toman_total`, `note`, `raw_text`, `joke`, `linked_deal_id`, `batch_id`, `status` (pending/approved/rejected/cancelled), `card_msg_id`, `source_msg_id`, `created_by`, `created_by_id`, `created_at`, `decided_by`, `decided_at`, `cancelled_by`, `cancelled_at`; index `(chat_id, id)` |
| `entry_events` | `id`, `entry_id`, `action` (edit/cancel), `actor`, `at`, `before_json`, `after_json` |
| `pending_actions` | `id`, `chat_id`, `kind` (edit), `entry_id`, `payload_json`, `created_by`, `created_at`, `status` (pending/applied/discarded) |
| `accounts` | `chat_id` PK, `title`, `display_name`, `type`, `bot_status`, `reminders_on` (default 1), `humor_on` (default 1), `archived` (default 0), `reminded_on`, `updated_at` |
| `admins` | `user_id` PK, `name`, `added_by`, `added_at` |
| `settings` | `key` PK, `value` (keys: `bot_id`, `bot_username`, `deviation_pct`) |
| `processed_updates` | `update_id` PK, `at` |
| `user_state` | `user_id` PK, `state`, `data_json`, `updated_at` |
| `broadcasts` | as v1, plus `status` (sending/done/deleting/deleted), `status_chat_id`, `status_msg_id` |
| `broadcast_messages` | `broadcast_id`, `chat_id`, `message_id`, `error`, `state` (queued/sent/failed/delete_queued/deleted/delete_failed); PK `(broadcast_id, chat_id)` |

**Interfaces** (all `async`, first argument `db: D1Database`):
- Produces:
  - `type Status = "pending" | "approved" | "rejected" | "cancelled"`
  - `dealCode(id: number): string` → `"D-" + id padded to 5 digits`
  - `interface Entry { id; chatId; code /* dealCode(id) */; trade: Trade; status; batchId; linkedDealId; cardMsgId; joke; createdBy; createdById; createdAt; decidedBy; decidedAt; cancelledBy; cancelledAt }`
  - Entries:
    - `createEntry(db, e: NewEntry): Entry`
    - `getEntry(db, id): Entry | null`
    - `getByCode(db, chatId, code)`
    - `findByCardMessage(db, chatId, msgId)`
    - `entriesInBatch(db, batchId)`
    - `setCardMessage(db, id, msgId)`
    - `setBatch(db, ids: number[], batchId)`
  - `transition(db, ids: number[], from: Status, to: Status, fields?): boolean`: one `UPDATE … WHERE id IN (…) AND status = from`. It returns true only if **every** id changed, and rolls back via `db.batch` otherwise. This is the double-tap guard.
  - `editEntry(db, id, trade: Trade, actor, at): Entry`: writes an `entry_events` row with the before/after trade JSON.
  - `cancelEntry` is just `transition` plus an event row: `recordEvent(db, entryId, action, actor, at, before, after)`.
  - Queries: `recent(db, chatId, limit)`, `approvedLedger(db, chatId): LedgerEntry[]`, `allApprovedByChat(db): Map<number, LedgerEntry[]>`, `listEntries(db, filter: { status?; kind?; chatId?; limit; before? })`.
  - Accounts:
    - `upsertAccount(db, { chatId, title, type, at, botStatus? })`: like v1 `upsert_chat`, it doesn't overwrite an admin status with `member` when `botStatus` is absent, and revives `left`.
    - `getAccount`, `listAccounts(db, { activeOnly?; includeArchived? })`, `updateAccount(db, chatId, patch)`, `accountName(a)` (`display_name ?? title`).
  - `migrateChat(db, from, to)`: moves `entries`, `pending_actions`, `broadcast_messages` and the account row.
  - Admins: `isAdmin(db, adminIds, userId)`, `listAdmins`, `addAdmin`, `removeAdmin`.
  - `getSetting(db, key)`, `setSetting(db, key, value)`
  - `markUpdateSeen(db, updateId, at): boolean` (`INSERT OR IGNORE`; true if inserted), `pruneUpdates(db, olderThan)`
  - `getUserState`, `setUserState`, `clearUserState`
  - `createPendingAction`, `takePendingAction(db, id, to: "applied" | "discarded"): row | null` (CAS on `status = 'pending'`)

- [ ] **Step 1: Write failing tests** in `test/db.test.ts` against the real D1 binding from the pool:
  - `transition is exclusive`: the second `pending → approved` returns false.
  - `batch transition is all-or-nothing`: with one batch member already rejected, transitioning `[a, b]` returns false and `a` stays pending.
  - `recent is per chat, newest first`
  - `toman_total and decimals round-trip exactly`: `1893.94` and `500000000` come back unchanged.
  - `editEntry records before/after event`
  - `migrateChat moves entries and account`: entries, `reminders_on` and the title carry over to the new id, and the old account row is gone.
  - `upsertAccount keeps admin status but revives left`: a port of v1 `test_seeing_a_message_keeps_admin_status_but_revives_left`.
  - `isAdmin`: true for an id in the `ADMIN_IDS` set, true for an `admins` row, false otherwise.
  - `markUpdateSeen true once`
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** `migrations/0001_init.sql` and `src/db.ts`.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: D1 schema and data access`.

### Task 5: Telegram client, cards and joke lines

**Files:**
- Create: `src/telegram.ts`, `src/cards.ts`, `src/jokes.ts`, `test/fakes.ts` (extend), `test/cards.test.ts`

**Interfaces:**
- Produces from `telegram.ts`:
  - `interface Tg { call<T = any>(method: string, params: Record<string, unknown>): Promise<T> }`
  - `createTg(token: string, f: typeof fetch): Tg`: POST JSON to `https://api.telegram.org/bot<token>/<method>`. On `ok: false` it throws `TgError`.
  - `class TgError extends Error { code: number; retryAfter?: number; migrateTo?: number }`, built from `error_code` and `parameters`.
  - `isForbidden(e)`: code 403, or 400 with "chat not found".
  - `isNotModified(e)`
- Produces from `test/fakes.ts`:
  - `FakeTg implements Tg` with `calls: { method; params }[]`, `reply(method, fn)` to script responses (default `{ message_id: n++ }`), and `fail(method, chatId, err)`.
- Produces from `cards.ts` (all return HTML strings, built in the v1 `accbot/card.py` style and copy):
  - `jalali(iso)`, `jalaliDate(iso)`
  - `renderEntry(e: Entry, o?: { error?: string; confirmCancel?: boolean; ref?: Decimal | null; deviationPct?: Decimal | null; alertPct?: Decimal })`
    - It shows the Nobitex reference and deviation for priced trades when `ref` is given, with ⚠️ if `|pct| > alertPct`.
    - It appends `e.joke` in italics as the last line before the status.
  - `entryKeyboard(e, confirmCancel?)`: callbacks `ok:<id>`, `no:<id>`, `cx:<id>`, `cy:<id>`, `cn:<id>`. Same layout as v1 `keyboard()`.
  - `renderSettlement(deal: Entry, payments: Entry[])` and `settlementKeyboard(batchId)` (`ok:<firstId>` / `no:<firstId>`)
  - `renderEditProposal(e: Entry, next: Trade, actionId)` and `editKeyboard(actionId)` (`ea:<id>` apply, `ed:<id>` discard)
  - `renderList(name, entries)`
  - `renderBalance(name, acc: Account, open: { id: number; legs: Leg[] }[])`. It labels deals with `dealCode(id)`.
  - `renderReminder(name, acc, open: { id: number; legs: Leg[] }[], nudge: string)`: shows what the client owes per asset and, **when we owe anything, what we owe**, then the open deals with remaining.
  - `renderPrices(usdt: UsdtPrice | null, quotes: CoinQuote[])`
- Produces from `jokes.ts`:
  - `ORDINARY_LINES`, `NUDGE_LINES`, `CLIENT_WRITE_REFUSALS` (at least 8 Persian lines each, all within the hard lines)
  - `BUSY_TEXT`, `pick(lines: string[], seed: number): string` (deterministic: `lines[seed % length]`)

- [ ] **Step 1: Write failing tests** in `test/cards.test.ts`:
  - The card for a by-toman trade shows «۵۰۰٬۰۰۰٬۰۰۰ ÷ ۲۶۴٬۰۰۰».
  - A deviation above 3% shows ⚠️ and the Nobitex price; at or below 3%, there's no ⚠️.
  - A user-supplied `<b>` in a note or group name is escaped.
  - Keyboard: pending has ok/no/cx, approved has cx, and confirmCancel has cy/cn.
  - `renderReminder`: with the client owing `1000 USDT` and us owing `266,000,000 IRT`, the output contains both «۱٬۰۰۰» with تتر and «۲۶۶٬۰۰۰٬۰۰۰» with تومان. With us owing nothing, it doesn't contain «ما هم».
  - `renderBalance` for a fully settled account contains «تسویه».
  - `TgError` is parsed from `{ ok: false, error_code: 400, description: "...", parameters: { migrate_to_chat_id: -100123 } }`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: telegram client, cards and joke lines`.

### Task 6: Gemini NLU and intent mapping

**Files:**
- Create: `src/nlu.ts`, `src/intent.ts`, `test/nlu.test.ts`, `test/intent.test.ts`

**Interfaces:**
- Produces from `nlu.ts`:
  - `NluInput`:
    ```ts
    {
      text: string; role: "admin" | "client"; chat: "group" | "private";
      repliedText?: string; usdtToman?: string; deviationPct?: string;
      openDeals: { code: string; summary: string }[];  // ≤ 20, newest first
      accountNames?: string[];                         // private admin chat only, ≤ 200
    }
    ```
  - `NluOutput` matches the Gemini `responseSchema` exactly:
    ```ts
    {
      intent: "create_trade" | "record_payment" | "settle_deal" | "edit_deal" | "cancel_deal"
            | "query_balance" | "query_deals" | "query_price" | "chitchat" | "unclear";
      side?: "BUY" | "SELL"; direction?: "PAY" | "RECEIVE";
      amount_text?: string; amount_unit?: "asset" | "toman"; asset?: string; rate_text?: string; note?: string;
      deal_code?: string;                                      // e.g. "D-00012"
      changes?: { amount_text?: string; rate_text?: string; note?: string };
      coins?: string[]; client_hint?: string;
      reply?: string;                                          // Persian: answer for chitchat, question for unclear
      joke?: string;
    }
    ```
  - `interface Nlu { understand(i: NluInput): Promise<NluOutput | null> }` (null means failure)
  - `createGeminiNlu(apiKey: string, model: string, f: typeof fetch): Nlu`
    - POSTs to `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` with the `x-goog-api-key` header.
    - The body has `systemInstruction`, `contents`, and `generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0.7 }`.
    - Uses an 8 s timeout. Any error, non-200, missing candidate, or JSON that fails `isNluOutput` returns `null`.
  - `SYSTEM_PROMPT` (exported), in Persian or English. It covers:
    - our-side convention: خرید = we buy, دریافت/واریز by client = RECEIVE, پرداخت/ارسال by us = PAY,
    - the instruction to copy numbers **verbatim** into `*_text`,
    - the instruction to never compute,
    - the persona,
    - the joke hard lines from Global Constraints,
    - to use `unclear` with a question rather than guess,
    - the joke triggers: an amount implausibly large for this client, or a rate deviating more than the given threshold from the given Nobitex price.
- Produces from `intent.ts`:
  - `Action` union:
    - `{ kind: "create"; trade: Trade }`
    - `{ kind: "payment"; trade: Trade }`
    - `{ kind: "settle"; dealCode: string }`
    - `{ kind: "edit"; dealCode: string; changes: { amount?: Decimal; rate?: Decimal; note?: string } }`
    - `{ kind: "cancel"; dealCode: string }`
    - `{ kind: "balance"; clientHint?: string }`
    - `{ kind: "deals"; clientHint?: string }`
    - `{ kind: "price"; coins: string[] }`
    - `{ kind: "reply"; text: string }`
    - `{ kind: "refuse" }`
  - `toAction(o: NluOutput, ctx: { role: "admin" | "client"; usdtToman: Decimal | null; defaultAsset: string }): Action`
  - `expandRateShorthand(rate: Decimal, asset: string, usdtToman: Decimal | null): Decimal`: for USDT, if `rate < 10000` and `rate × 1000` is within ±50% of `usdtToman`, return `rate × 1000`. Otherwise return it unchanged.
  - `deviationPct(rate: Decimal, ref: Decimal): Decimal`: `(rate − ref) / ref × 100`, rounded to 1 place.

- [ ] **Step 1: Write failing tests.** `test/intent.test.ts`:
  - `create_trade` `{amount_text: "۱۰۰", asset: "تتر", rate_text: "۲۷۵ هزار"}` → BUY 100 USDT @ 275000.
  - `amount_unit: "toman"`, «۵۰۰ میلیون» @ «۲۶۴۰۰۰» → amount `1893.94`, tomanTotal `500000000`. That's the same conversion as the parser, so reuse a shared helper exported from `parser.ts`: `fromToman(toman, rate, asset)`.
  - Rate shorthand: «۲۷۵» with usdtToman 266001 → 275000. «۲۷۵» with usdtToman null → stays 275.
  - An unparsable `amount_text` → `{ kind: "reply" }` with a Persian clarifying question.
  - Client writes (`create_trade`, `record_payment`, `settle_deal`, `edit_deal`, `cancel_deal` with role client) → `{ kind: "refuse" }`.
  - `record_payment` without an asset → asset `IRT`.
  - `deviationPct(280000, 266000) = 5.3`

  `test/nlu.test.ts` with `fakeFetch`:
  - A valid candidate's JSON text → the parsed `NluOutput`.
  - A 429 → null.
  - Non-JSON text → null.
  - JSON missing `intent` → null.
  - The request body contains `responseSchema` and the `x-goog-api-key` header equals the key.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: gemini NLU and intent mapping`.

### Task 7: Webhook entry, update routing, group tracking, setup

**Files:**
- Create: `src/app.ts`, `src/handlers/update.ts`, `test/update.test.ts`
- Modify: `src/index.ts`
- Extend: `test/fakes.ts` with `makeApp(overrides?)`, which returns an `App` with `FakeTg`, `FakeNlu` (scripted outputs), a fixed `now`, `adminIds = {1}`, and `defer` collecting promises plus `flush()`.

**Interfaces:**
- Consumes: db, telegram, Task 8's `handleMessage`, and Task 9's `handleCallback`. Stub both as no-ops until those tasks; this task only routes.
- Produces:
  - `handleUpdate(app: App, u: Update): Promise<void>`
  - `isAddressed(msg: Message, bot: { id: number; username: string }): { text: string } | null`. It returns the text with the `@username` mention removed when the bot is mentioned (an entity `mention` equal to `@username`, case-insensitive, or `text_mention.user.id === bot.id`), when the message is a reply to a message whose `from.id === bot.id`, or when the text starts with `#` (text as-is). Otherwise it returns null. In private chats every non-command text counts as addressed.
  - `botInfo(app): Promise<{ id; username }>`, read from settings.
  - `index.ts` routes:
    - `POST /tg`:
      - reject with 401 unless the `X-Telegram-Bot-Api-Secret-Token` header equals `WEBHOOK_SECRET`,
      - parse the JSON,
      - `app.defer(handleUpdate(...))`,
      - return 200 at once.
    - `POST /setup`: same header check. It runs:
      1. `getMe`, then stores `bot_id` and `bot_username`.
      2. `setWebhook { url: origin + "/tg", secret_token, allowed_updates: ["message", "callback_query", "my_chat_member"], drop_pending_updates: true }`.
      3. `setMyCommands` for groups (`deals`, `balance`, `help`, `id`) and private chats (`app`, `broadcast`, `groups`, `cancel`, `help`, `id`).
      4. `setChatMenuButton { menu_button: { type: "web_app", text: "پنل مدیریت", web_app: { url: origin + "/app/" } } }`.

      It returns JSON of each result.
    - `/api/*` → Task 13 (404 stub for now).
    - Everything else → `env.ASSETS.fetch(req)`.
- `handleUpdate` order:
  1. `markUpdateSeen`; return if seen.
  2. `message.migrate_to_chat_id` → `migrateChat`, then return.
  3. Group chat → `upsertAccount` (without `botStatus`).
  4. `my_chat_member` → `upsertAccount` with `botStatus = new_chat_member.status`.
  5. `callback_query` → `handleCallback`.
  6. A text message starting with `/` → `handleCommand` (Task 10; stub).
  7. A private message of **any type** (text, photo, video, document…) while `user_state.state = "broadcast_waiting"` → broadcast capture (Task 12; stub). This step runs before the command check for non-command messages. `/cancel` still goes to `handleCommand`.
  8. Addressed text → `handleMessage(app, msg, text)`.
  9. Otherwise ignore.
- Wrap the body in try/catch and `console.error`, so one bad update never throws out of `waitUntil`.

- [ ] **Step 1: Write failing tests** in `test/update.test.ts`:
  - `duplicate update_id is processed once`: `handleMessage` spy called once.
  - `mention is addressed and stripped`: «@acc_bot خرید ۱۰۰ تتر» → «خرید ۱۰۰ تتر».
  - `reply to bot message is addressed`
  - `plain group chatter is ignored`
  - `# message is addressed`
  - `migrate message triggers migration`: entries move to the new id.
  - `my_chat_member kicked marks account`
  - `webhook rejects wrong secret with 401`: call `worker.fetch` with a `Request`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: webhook routing, group tracking and setup route`.

### Task 8: Message handling: cards, answers, refusals

**Files:**
- Create: `src/handlers/message.ts`, `test/message.test.ts`

**Interfaces:**
- Consumes:
  - `parseMessage`, `TradeError` (Task 2)
  - `Nlu`, `toAction`, `expandRateShorthand`, `deviationPct` (Task 6)
  - prices (Task 1), db (Task 4), cards and jokes (Task 5)
- Produces: `handleMessage(app: App, msg: Message, text: string): Promise<void>`

**Behavior:**

1. **Setup.**
   - `role = isAdmin ? "admin" : "client"`.
   - `usdt = await fetchUsdtToman(app.fetch)`. A failure gives null.
   - In a group, `account = getAccount(chat.id)`.
2. **Fast path.** If the text starts with `#`, run `parseMessage`.
   - A `TradeError` → reply with its message.
   - A client → reply with `pick(CLIENT_WRITE_REFUSALS, msg.message_id)`.
   - An admin → `action = { kind: "create" | "payment", trade }`, and `joke = pick(ORDINARY_LINES, message_id)`.
   - **Exception:** when a priced trade deviates more than `deviation_pct` and humor is on, call `nlu.understand` for the joke only, and fall back to the ordinary line if it fails.
3. **NL path** (not `#`, or `#` that didn't parse):
   - Call `nlu.understand` with `openDeals` from `recent(chat, 20)` (pending and approved only) and `repliedText = msg.reply_to_message?.text`.
   - A null result → reply `BUSY_TEXT`.
   - Otherwise `action = toAction(...)`, and `joke = humor_on ? out.joke : undefined`.
4. **Reply to a card.** If the message replies to a bot card (`findByCardMessage`) and the action is settle, edit or cancel without a `dealCode`, use that card's entry.
5. **Dispatch by `action.kind`:**
   - `create` / `payment`:
     - `createEntry` (status pending, joke stored).
     - Reply with `renderEntry(e, { ref: usdt?.latest, deviationPct, alertPct })` and `entryKeyboard`.
     - `setCardMessage`.
   - `settle`:
     - Resolve the deal by code in this chat. It must be approved and open, according to `allocate(approvedLedger(chat))`.
     - Create one pending payment per leg with `remaining > 0`: `client_owes` → RECEIVE, `we_owe` → PAY, with the leg's asset and `linkedDealId = deal.id`.
     - Then `setBatch(ids, ids[0])`.
     - Reply with `renderSettlement` and `settlementKeyboard`.
     - A deal that isn't found or is already settled → a Persian reply saying so.
   - `edit`:
     - The deal must exist in this chat with status pending or approved.
     - Build the next `Trade` with the changes applied. If `tomanTotal` was set and the rate changed, recompute the amount with `fromToman`.
     - `createPendingAction(kind: "edit", payload: next trade JSON)`.
     - Reply with `renderEditProposal` and `editKeyboard`.
   - `cancel`:
     - Find the deal.
     - Reply with `renderEntry(e, { confirmCancel: true })` and `entryKeyboard(e, true)` for approved deals. For pending deals, reply with the normal pending keyboard.
   - `balance`:
     - Group → this chat's account, always. Ignore `clientHint` for everyone in groups.
     - Private admin chat → find accounts whose `accountName` contains `clientHint`. Exactly one → its balance. Otherwise → a list of matching names, or «پیدا نشد».
     - Render with `renderBalance(name, summarize(...), openDeals(...))`.
   - `deals`: like balance, but `renderList(name, recent(chat, 15))`.
   - `price`: `renderPrices(usdt, await quoteCoins(coins.filter(c => c !== "USDT"), app.fetch))`.
   - `reply`: send the text.
   - `refuse`: `pick(CLIENT_WRITE_REFUSALS, …)`.
   - Append `joke` (when present and humor is on) as an italic line to non-card replies.
6. **Reply style.** All replies use `reply_parameters: { message_id: msg.message_id }` and HTML.

- [ ] **Step 1: Write failing tests** in `test/message.test.ts` using `makeApp`, `fakeFetch` and scripted `FakeNlu`:
  - `# admin trade creates pending card`: a `sendMessage` with `ok:` buttons and status pending in D1.
  - `# trade with 5% deviation shows warning and asks nlu for a joke`
  - `client write is refused`: no entry created.
  - `client balance ignores client_hint`: a client in chat A asks with `client_hint: "B"` and gets A's balance text.
  - `admin private balance by name`: one match → that balance.
  - `gemini failure falls back`:
    - for NL text, sends `BUSY_TEXT`,
    - for `#` text with Gemini null, still creates the card with an ordinary line.
  - `settle creates linked batch`: an approved `SELL 1000 USDT @ 266000` → two pending entries (RECEIVE IRT 266,000,000 and PAY USDT 1000) sharing `batch_id`, both linked to the deal.
  - `settle already-settled deal replies not open`
  - `reply to card resolves deal for cancel`
  - `edit creates pending action, does not change entry`
  - `nobitex down → card without reference`
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: natural-language message handling`.

### Task 9: Card buttons

**Files:**
- Create: `src/handlers/callback.ts`, `test/callback.test.ts`

**Interfaces:**
- Produces:
  - `handleCallback(app: App, q: CallbackQuery): Promise<void>`
  - `notifyChange(app, entry, text)`: a short group notice, used by the Mini App (Task 13).
- **Permissions:** every action requires an admin. Otherwise answer `answerCallbackQuery { text: "شما اجازه این کار را ندارید.", show_alert: true }`.
- **Actions:**
  - `ok:<id>`: if the entry has a `batchId`, `transition(all batch ids, pending → approved)`; otherwise just `[id]`. Then edit the card with the fresh render. A false result → answer «این مورد قبلاً بررسی شده است.».
  - `no:<id>`: the same, but `pending → rejected`.
  - `cx:<id>`:
    - pending → cancel it directly (the batch too),
    - approved → show the confirm keyboard.
  - `cy:<id>`:
    - `approved → cancelled` plus `recordEvent("cancel")`.
    - If approved linked payments reference this deal, null out their `linked_deal_id` (spec: payments stay, back to FIFO) and add the line «پرداخت‌های مرتبط باقی ماندند و به حساب کلی برگشتند» to the card.
    - Append the new account balance line from `summarize`.
  - `cn:<id>`: restore the normal keyboard.
  - `ea:<actionId>`: `takePendingAction(applied)`, then `editEntry(next trade)`. Edit the proposal message to show the change done. If the entry is approved, also re-render its original card (if `card_msg_id`) with the new values.
  - `ed:<actionId>`: `takePendingAction(discarded)`, then edit the message.
- **Rendering errors:** "message is not modified" errors on edit are swallowed (`isNotModified`).

- [ ] **Step 1: Write failing tests**:
  - `approve moves pending to approved and edits card`
  - `second approve is a no-op`: one `editMessageText`, then an answer «قبلاً».
  - `non-admin cannot approve`
  - `approving settlement approves whole batch`: the deal's remaining becomes 0 via `allocate`.
  - `cancel approved needs confirm`: `cx` → keyboard only, `cy` → cancelled plus an event.
  - `cancel deal with linked payment keeps payment unlinked`
  - `apply edit changes entry and records event`
  - `apply edit twice is a no-op`
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: approval, cancel, settlement and edit buttons`.

### Task 10: Commands

**Files:**
- Create: `src/handlers/commands.ts`, `test/commands.test.ts`

**Interfaces:**
- Produces: `handleCommand(app, msg): Promise<void>`. Strip `@botname` from the command.
  - `/start` and `/help`: rewrite the v1 `HELP` (`accbot/main.py:43-70`) for the new style. Tag or reply in plain language, a few examples, `#` still works, clients can ask about balance and prices, and the command list.
  - `/id`: as v1.
  - `/deals [n]` (default 15, max 40; Persian digits allowed) and `/balance`: as v1, using `renderList` and `renderBalance`.
  - `/app` (private, admin only): a message with an inline `web_app` button to `origin + "/app/"`. Store the origin in settings at `/setup` as `public_url`.
  - `/broadcast`, `/groups`, `/cancel` → delegate to Task 12 (stub until then).

- [ ] **Step 1: Write failing tests**:
  - `/deals ۳۰` lists up to 30.
  - `/deals 100` caps at 40.
  - `/balance` in a group uses that chat.
  - `/app` from a non-admin is denied.
  - `/help@acc_bot` works.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: bot commands`.

### Task 11: Daily reminders and cron

**Files:**
- Create: `src/reminders.ts`, `src/cron.ts`, `test/reminders.test.ts`
- Modify: `src/index.ts` (add `scheduled` calling `runCron(app, new Date(event.scheduledTime))`)

**Interfaces:**
- Produces:
  - `runCron(app, at: Date): Promise<void>`, which runs `runReminders`, then `runBroadcastBatch` (Task 12; stub until then), then `pruneUpdates(older than 2 days)`.
  - `runReminders(app, at: Date): Promise<{ sent: number; remaining: number }>`
    - If Tehran local time is before 10:00, return.
    - `today` is the Tehran date `YYYY-MM-DD`.
    - Candidates: accounts that are active (bot_status member/administrator/creator), not archived, `reminders_on = 1`, and `reminded_on IS NOT today`. Ordered by chat_id. Process at most `BATCH_SIZE` per call.
    - For each: build `summarize` and `openDeals` from `allApprovedByChat`.
      - If any asset has `owed > 0`, send `renderReminder(name, acc, open, pick(NUDGE_LINES, chatId + dayNumber))`.
      - Mark `reminded_on = today` **whether or not it sent**, so non-debtors aren't rechecked.
    - On a `TgError`:
      - `isForbidden` → `updateAccount(bot_status: "left")` and continue.
      - `migrateTo` → `migrateChat` and retry once.
      - `retryAfter` → stop this batch. The next minute continues.

- [ ] **Step 1: Write failing tests**:
  - `before 10:00 Tehran sends nothing`: 06:29 UTC.
  - `sends only to debtors`: three accounts (owes us, we owe, settled) → exactly one `sendMessage`.
  - `shows both sides`: the client owes 1000 USDT and we owe 266M → the text contains both.
  - `idempotent same day`: a second run sends 0.
  - `batches`: 45 debtors → the first run sends 40, the second sends 5.
  - `403 marks left and continues`: the first chat fails with 403 and the second still gets a message.
  - `reminders_off and archived are skipped`
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: daily debtor reminders on cron`.

### Task 12: Broadcast (port, batched)

**Files:**
- Create: `src/broadcast.ts`, `test/broadcast.test.ts`

**Interfaces:**
- Produces: `onBroadcastCommand`, `onBroadcastCapture`, `onGroupsCommand`, `onCancelCommand`, `handleBroadcastCallback(app, q)`, and `runBroadcastBatch(app)`.
- **Behavior:** the same user flow and copy as v1 `accbot/broadcast.py`, with these differences:
  - **Allowed users:** admins only, and **never** a fallback to anyone. With no admins at all (an empty `ADMIN_IDS` and no rows), deny with the v1 activation text.
  - **State:** waiting/source state lives in `user_state`: `broadcast_waiting`, then `broadcast_confirm` with `{ fromChatId, fromMessageId, preview }`.
  - **`bc:go`:**
    1. Create the broadcast (status `sending`, the status message ids).
    2. Insert a `broadcast_messages` row with state `queued` for every active, non-archived account.
    3. Edit the status to «⏳ در حال ارسال…».
    4. `app.defer(runBroadcastBatch(app))`.
  - **`runBroadcastBatch`:**
    - Take up to `BATCH_SIZE` rows that are `queued` (copyMessage) or `delete_queued` (deleteMessage), across broadcasts, oldest first.
    - On errors:
      - `migrateTo` → migrate and retry once,
      - forbidden → mark the account left and the row failed,
      - `retryAfter` → stop the batch.
    - When a broadcast has no queued rows left, set it `done` and edit the status message with the v1 report text and delete keyboard (or `deleted` with the deleted/failed counts).
  - **Delete callbacks:** `bd`, `bdn` and `bdy` as v1. `bdy` marks the `sent` rows `delete_queued`.

- [ ] **Step 1: Write failing tests** (port the v1 `tests/test_broadcast.py` intent):
  - `deny when no admins`
  - `full flow queues and sends`: three active groups → three `copyMessage` calls and a report «۳ از ۳».
  - `failed delivery recorded, batch continues`
  - `migrated chat retried at new id`
  - `kicked/left/archived groups excluded`
  - `delete-all queues and deletes sent rows`
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: batched broadcast`.

### Task 13: Mini App auth and API

**Files:**
- Create: `src/miniapp/auth.ts`, `src/miniapp/api.ts`, `test/miniapp.test.ts`
- Modify: `src/index.ts` (route `/api/*`)

**Interfaces:**
- Produces:
  - `validateInitData(initData: string, botToken: string, nowSec: number, maxAgeSec = 86400): Promise<{ id: number; name: string } | null>`
    - Telegram's algorithm: `secret = HMAC_SHA256(key = "WebAppData", msg = botToken)`, and `hash = hex(HMAC_SHA256(key = secret, msg = data_check_string))`.
    - The `data_check_string` is the sorted `key=value` pairs (excluding `hash`), joined by `\n`.
    - Also reject when `auth_date` is older than `maxAgeSec`.
    - Use WebCrypto.
  - `handleApi(app, req): Promise<Response>`.
    - Every route requires `Authorization: tma <initData>`, which must be valid and belong to an admin. Otherwise return 401 or 403.
    - JSON in and out. Money is sent as strings. Amount inputs go through `parseAmountText`, so Persian digits and «میلیون» work.

| Method and path | Does |
|---|---|
| `GET /api/dashboard` | `{ usdt: UsdtPrice \| null, receivable: {asset: amount}, payable: {asset: amount}, todayVolumeUsdt, pendingCount, topDebtors: [{chatId, name, owed: {asset: amount}}] (≤ 5, ranked by IRT owed then USDT owed) }`. Per asset, never converted (spec). |
| `GET /api/accounts` | All accounts with name, flags and `owed` per asset. `?archived=1` includes archived ones. |
| `GET /api/accounts/:chatId` | The account, its `owed`, `openDeals` (with legs) and the last 100 entries. |
| `PATCH /api/accounts/:chatId` | `{ display_name?, reminders_on?, humor_on?, archived? }` |
| `POST /api/accounts/:chatId/payments` | `{ direction: "PAY" \| "RECEIVE", amount: string, asset?: string, note?, linkedDealId? }` → creates an **approved** entry (the admin in the Mini App is the approver), then `notifyChange` to the group. |
| `GET /api/entries` | `?status&kind&chatId&before&limit` (limit ≤ 100) |
| `POST /api/entries/:id/approve` and `POST /api/entries/:id/reject` | Same `transition` as Task 9 (including batches). Edits the group card if `card_msg_id`. |
| `POST /api/entries/:id/cancel` | Same semantics as `cy` (linked payments unlinked), then `notifyChange`. |
| `PATCH /api/entries/:id` | `{ amount?, rate?, note? }` → `editEntry`, then `notifyChange`. Same toman-recompute rule as Task 8. |
| `GET/POST/DELETE /api/admins` | List, add (`{ userId, name }`), remove. Env admins are listed as non-removable. |
| `GET/PATCH /api/settings` | `{ deviation_pct }` |

- [ ] **Step 1: Write failing tests**:
  - `validateInitData accepts a correctly signed string`: build one in the test with the same HMAC steps.
  - `validateInitData rejects a tampered string or an expired auth_date`
  - `api 401 without header`, `api 403 for non-admin`
  - `dashboard per-asset totals`: two accounts (one owes us 10M IRT, we owe the other 50 USDT) → receivable `{ IRT: "10000000" }`, payable `{ USDT: "50" }`.
  - `post payment with Persian amount «۵۰ میلیون» creates approved RECEIVE 50000000 and notifies group`
  - `edit entry records event and notifies`
  - `cancel entry via api unlinks payments`
  - `client in another chat cannot be reached without admin`: an admin check on every route.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: mini app auth and admin API`.

### Task 14: Mini App frontend

**Files:**
- Create: `public/app/index.html`, `public/app/app.js`, `public/app/app.css`

**Interfaces:**
- Consumes: the Task 13 API.
- **Approach:**
  - Load `https://telegram.org/js/telegram-web-app.js`. Use `Telegram.WebApp.initData` for the `Authorization: tma …` header and `themeParams` for the colors.
  - `dir="rtl"`, a Vazirmatn font from Google Fonts, Persian digits via `Intl.NumberFormat("fa-IR")`.
  - Layout **B** (owner's pick; see the mockup in the spec conversation):
    - top: live USDT price,
    - dashboard: 4 KPI tiles (receivable, payable, today's volume, pending) and top debtors,
    - bottom tabs: داشبورد / مشتری‌ها / معاملات / تنظیمات.
  - Client detail:
    - per-asset balance, open deals with remaining, history,
    - a «ثبت واریز» form (direction, amount text, asset, note, optional deal),
    - rename, reminder and humor toggles, archive.
  - Deals tab:
    - status and type chips, a client filter, "load more" pagination,
    - per-row approve/reject (pending), edit (a modal with amount, rate and note) and cancel (`Telegram.WebApp.showConfirm` before calling).
  - Settings: the admin list (add/remove) and `deviation_pct`.
  - Errors show a Persian toast. A 401/403 shows «فقط مدیران به این بخش دسترسی دارند».

- [ ] **Step 1: Build the three files.**
- [ ] **Step 2: Manual check.**
  - Run `npm run dev` and open `http://localhost:8787/app/` in a browser. Expected: the page renders RTL and shows the 401 toast (no initData).
  - Run `npm test` to confirm nothing regressed.
- [ ] **Step 3: Commit** with message `feat: mini app frontend`.

### Task 15: Retire v1, docs, deploy and smoke test

**Files:**
- Delete: `accbot/`, `tests/`, `pyproject.toml`, `requirements.txt`, `Dockerfile`, `docker-compose.yml`, `.env.example`
- Create: `.dev.vars.example` (if not done in Task 1), listing the four secret names with empty values
- Modify: `README.md` (rewrite for v2), `CLAUDE.md` (commands, architecture, the constraints from this plan's Global Constraints)

- [ ] **Step 1: Delete the v1 files.** Rewrite README to cover:
  - how to talk to the bot,
  - roles,
  - the Mini App (and the VPN note for `workers.dev`),
  - setup: `wrangler login`, `d1 create`, `db:migrate`, `secret put` ×4, `deploy`, `curl -X POST -H "X-Telegram-Bot-Api-Secret-Token: …" https://…/setup`,
  - tests.

  Update CLAUDE.md the same way.
- [ ] **Step 2: Run `npm test`.** Expected: all pass. Run `npx tsc --noEmit`. Expected: no errors.
- [ ] **Step 3: Deploy (needs the owner).**
  - Remind the owner to **rotate the bot token** (BotFather `/revoke`) and **the Gemini key** first, because both were pasted in chat.
  - The owner runs `! npx wrangler secret put BOT_TOKEN` and the same for `GEMINI_API_KEY`, `WEBHOOK_SECRET` (a random 32+ chars) and `ADMIN_IDS`.
  - Then run `npm run db:migrate`, `npm run deploy`, and the `/setup` curl.
  - Expected: `/setup` JSON shows `setWebhook: true`.
- [ ] **Step 4: Smoke test in a real test group** with the owner:
  1. Tag «@bot خرید ۱۰۰ تتر رو ۲۷۵» → a card with the Nobitex comparison and a joke.
  2. ✅ → approved.
  3. «@bot تسویه» as a reply to the card → a settlement card.
  4. A client account asks «@bot تتر چنده» → the price.
  5. The client tries «@bot خرید ۱۰ تتر» → refused.
  6. Open the Mini App from the menu button → the dashboard numbers match `/balance`.
- [ ] **Step 5: Shut down v1** (owner): `ssh pingi-stage 'cd /opt/acc-bot && docker compose down'`. The old bot uses polling with the same token; once the webhook is set, the polling bot would conflict, so stop it before or right after `/setup`.
- [ ] **Step 6: Commit** with message `chore: retire python v1, document v2`.
