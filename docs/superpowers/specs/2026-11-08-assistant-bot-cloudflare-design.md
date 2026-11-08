# acc-bot v2: natural-language assistant on Cloudflare Workers

Date: 2026-11-08
Status: draft, awaiting approval

## Intent

acc-bot records crypto (mostly USDT) trades between us (the dealer) and clients. Each client has a Telegram group that includes us and the bot. Right now the bot reacts only to rigid `#خرید …` syntax. The owner wants it to behave **like a staff member**: you tag it or reply to it, talk in plain Persian ("خرید ۱۰۰ تا تتر رو قیمت فلان", "واریز ۵۰ میلیون به حساب ملت", "تسویه معامله‌ی دیروز"), and it understands. It should also:

- check live prices (USDT/toman from Nobitex, other coins from a foreign exchange),
- answer with a witty, bazaari, teasing tone,
- remind clients every morning what they owe,
- come with an admin Mini App to see and manage everything.

The whole thing moves to Cloudflare Workers. That also ends the dependency on pingi-stage's SOCKS proxy.

## Goals

1. **Natural-language input** in client groups. The bot acts when it's @-mentioned or someone replies to one of its messages. The legacy `#` syntax keeps working whenever the bot can see the message.
2. **Two roles:**
   - **Admins** (us) can create trades, payments, settlements, edits and cancellations.
   - **Clients** (anyone else in the group) can only ask questions about their own account, their deals and prices.
3. **Nothing reaches the ledger without an admin tapping ✅ on a confirmation card.** The card shows exactly what the bot understood.
4. **Live prices:** USDT→toman from Nobitex, fetched fresh on every request with no caching. Other coins come from KuCoin's public API.
5. **Humor:** a short witty line next to each reply. It reacts to things like an implausibly large amount ("آخه تو قیافت به این پول می‌خوره؟") or a price far from Nobitex ("نوبیتکس داره ۲۶۶ می‌ده، تو خون ما رو ۲۸۰ می‌فروشی؟").
6. **Accounts:** one account per client group, named after the group title (and renamable).
7. **Daily reminder at 10:00 Tehran time** in each group, sent **only when the client owes us** something. It says what they owe and which deals are still open.
8. **Admin Mini App** (dashboard-first layout, "B"):
   - Dashboard: live USDT price, total receivable, total payable, today's volume, pending count, and top debtors.
   - Clients, deals and settings tabs.
   - Actions: record a payment, edit a deal, cancel a deal, and manage clients (rename, toggle reminder or humor, archive).
9. **Fresh start:** a new, empty database. The old bot is shut down once v2 is live.

## Non-goals

- Google Sheets mirroring is removed.
- No migration of existing SQLite data.
- No Mini App access for clients.
- No Excel export for now. It may come later.
- No multi-language UI. All user-facing text is Persian.

## Anti-goals (failure even if it "works")

- **Jokes that insult a client's family.** That's the owner's hard line. My call: religion, ethnicity, physical appearance beyond light "قیافت به این پول نمی‌خوره"-style teasing, and anything sexual are also off-limits.
- **The LLM writing to the ledger**, or doing the money arithmetic. Gemini only *extracts* fields. All amounts, totals, conversions and balances are computed by our own deterministic code.
- **A client seeing another client's data**, through a question in the group or through the Mini App.
- **A joke replacing or hiding the numbers.** The card's facts always come first and stay complete.
- **Silent failure.** If Gemini or a price API is down, the bot still works without the joke or the price, and it says so instead of guessing.

## Constraints

- **Runtime:** Cloudflare Workers, Telegram **webhook** (no polling).
  - Telegram expects a quick 200 and retries otherwise. Gemini calls can take seconds. So acknowledge immediately, do the work in `ctx.waitUntil`, and dedupe by `update_id`.
- **Storage:** Cloudflare D1 (SQLite). Daily reminder: a Cron Trigger at `30 6 * * *` UTC (= 10:00 Asia/Tehran; Iran has no DST).
- **Language:** TypeScript. My call: the current Python stack (python-telegram-bot polling, sync sqlite3) can't run on Workers. The existing parsing rules, ledger sign convention and tests are ported, not rewritten from scratch.
- **Cloudflare Workers Free plan** (owner's choice), so design for these limits:
  - ~50 external subrequests per invocation,
  - 10 ms CPU per request (time spent waiting on `fetch` doesn't count),
  - a small number of cron triggers.

  Anything that fans out to many groups (reminders, broadcast) must be batched across invocations. Use Cloudflare Queues if they're available on the Free plan at build time (the builder verifies this); otherwise use cron-driven batches with resumable state in D1.
- **No custom domain** (owner's choice). The Mini App is served from `*.workers.dev`, which is usually filtered in Iran, so admins need a VPN to open it. This is accepted; adding a domain later must only need a config change. The bot itself is unaffected, because Telegram calls the webhook from outside Iran.
- **Gemini free tier** (owner's choice).
  - Google may use free-tier prompts to improve its models, and the prompts contain client names and amounts. The owner accepted this.
  - The free tier is rate-limited. On 429 or another error, the bot must degrade gracefully: answer `#` syntax via the fast path, and otherwise reply in Persian that it's busy and suggest the `#` form.
  - Never call Gemini when the fast path already parsed the message and there's nothing worth joking about. My call: send the plain card in that case, to save quota.
- **Secrets** go in Wrangler secrets, never the repo: `BOT_TOKEN`, `GEMINI_API_KEY`, `WEBHOOK_SECRET` (Telegram's `secret_token` header), `ADMIN_IDS` (initial admin Telegram IDs).
  - The Gemini key and bot token that were pasted into chat must be **rotated** before go-live.
- **Nobitex** v2 market stats were verified reachable from a non-Iranian datacenter (London, Akamai) on 2026-11-08: `GET https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls` returns prices in **rial**, so divide by 10 for toman.
  - **Must be re-verified from a deployed Worker as the very first step.** Cloudflare egress IPs may be treated differently. If blocked, stop and raise it. Don't silently switch sources.
- **KuCoin:** `GET https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=<COIN>-USDT` was verified working. A coin's toman price is the KuCoin USDT price × the Nobitex USDT/toman price.
  - My call: KuCoin over Binance, because Binance refuses some US-hosted IPs that Workers may run from.

## How it works

### Triggers and roles

The bot handles a group message when:
- it @-mentions the bot,
- it replies to a bot message, or
- it starts with `#`.

Everything else is ignored. With the bot's privacy mode **on**, Telegram still delivers mentions and replies. `#` messages only arrive if the bot is a group admin or privacy mode is off; that's acceptable.

**Clients cannot propose deals.** This is the owner's decision ("فقط ما ثبت کنیم") and a deliberate change from v1, where anyone could post a `#` deal for approval. A client's `#` or natural-language write is refused with a joke. Every entry is written from our side, so no side inversion is needed, and the v1 "creator may withdraw" rule only applies to admins.

Admins are `ADMIN_IDS` plus admins added in the Mini App settings. Group-admin status in Telegram grants nothing: clients may be group admins too. In a private chat, admins can ask cross-client questions ("بدهی علی چقدره؟"). Writes happen in the client's group, where the account is obvious, or in the Mini App.

### Understanding a message

1. **Fast path:** if the text matches the ported `#` grammar (`parser.py`), use that result. No LLM call is needed for the fields, but there may be one for the joke.
2. **Otherwise**, call Gemini with structured JSON output. The prompt includes:
   - the message,
   - the sender's role,
   - the replied-to message if there is one,
   - the live Nobitex price,
   - the account's open deals (for "تسویه معامله‌ی دیروز").

   It returns one intent:
   - `create_trade` (side, amount as written, amount unit: asset or toman, asset, rate, note)
   - `record_payment` (direction PAY/RECEIVE, amount, asset, note: e.g. bank or card)
   - `settle_deal` (which deal)
   - `edit_deal` or `cancel_deal` (which deal, what changes)
   - `query_balance`, `query_deals`, `query_price` (coins)
   - `chitchat`
   - `unclear` (with a clarifying question in Persian)

   Plus a `joke` string.
3. **Numbers** come back as the literal text the user wrote ("۲ میلیون", "۲۷۵ هزار"). They're normalized and multiplied by our own code, reusing the parser's normalize/multiplier logic, so the LLM never does arithmetic.
4. **Write intents** from a non-admin are refused with a joke. Write intents from an admin produce a **confirmation card** (the current card design, extended). It shows what was understood and, for trades, the deviation from Nobitex. ✅ approves it, ❌ discards it, 🚫 cancels it later.
5. **Unclear input** gets a clarifying question back, never a guess.

The Gemini model is configurable (`GEMINI_MODEL`). The builder picks the current fast Flash model.

### Humor

The joke is generated in the same Gemini call, so it costs no extra request. The prompt sets the persona (a sharp-tongued, friendly bazaar dealer) and the hard lines above, and receives facts so the jokes are grounded. Those facts are:
- the Nobitex price,
- the percentage deviation of the quoted rate,
- the amount relative to the client's history.

Some notes:
- **Price-gouging tease:** fires when the rate deviates **> 3%** from Nobitex. That's my call; it's tunable in settings.
- **Ordinary deals** get a short, warm line, not a roast every time. Use variety to avoid repeating. Ordinary `#` deals on the fast path take that line from a fixed hand-written set, with no Gemini call.
- **Humor can be switched off per group.**
- **If Gemini fails**, send the reply with no joke.

### Ledger, payments and settlement

- **Sign convention:** unchanged from `ledger.py`, everything from our side, per asset. `owed > 0` means the client owes us.
  - BUY: client owes the asset, we owe the toman.
  - SELL: the reverse.
  - PAY adds; RECEIVE subtracts.
- **Account balance:** the sum over approved entries.
- **Per-deal remaining** (needed for "how much is left" and for settlement): my call is FIFO.
  - A payment can be **linked to a deal**; settlements always are.
  - Unlinked payments are applied to the account's oldest open deal legs in the same asset, oldest first.
  - A deal is "open" while any leg has a remaining amount.
- **`settle_deal`** proposes the payment(s) that bring the chosen deal's remaining to zero, linked to that deal, shown on a confirmation card.
- **Edits and cancellations:**
  - Editing an approved deal never overwrites history. The old values are kept in a `deal_events` table (who, when, before/after) and the balance uses the current values.
  - Cancelling an approved deal asks for confirmation, as it does today.
  - Edits, cancellations and payments made in the Mini App post a short notice in the client's group. That's my call, so the client sees changes to their account.
  - My call: cancelling or editing down a deal that already has linked payments **keeps those payments**, since they're real money that moved. Their links are cleared and they go back into the FIFO pool. The cancellation card warns about this and shows the account balance after the change.

### Money figures in the Mini App

My call: figures are **per asset, never converted** (USDT and toman shown side by side), so numbers on a money screen don't drift with the live price.
- **Total receivable / payable:** the sums of positive / negative `owed` across accounts, per asset.
- **Today's volume:** the USDT amount traded in approved trades today.
- **Top debtors:** ranked by toman owed, then USDT owed.

### Daily reminder

A reminder is sent when an active account with reminders on has **any asset where the client owes us** (`owed > 0`). There's no cross-asset netting: the owner chose to show both sides instead.

The message contains:
- what the client owes per asset,
- **what we owe them, per asset, when we owe anything** (e.g. "شما ۱۰۰۰ تتر بدهکارید؛ ما هم ۲۶۶ میلیون تومان به شما بدهکاریم"),
- the open deals (oldest first, with remaining),
- a light nudge line.

Accounts that are settled, or where only we owe the client, get nothing. Groups the bot was removed from are skipped and marked.

**Free-plan batching (my call):** the run must not send every group in one invocation.
- The cron fires at 10:00 Tehran and then every few minutes until done. Each tick handles a batch that stays well under the per-invocation subrequest cap.
- A `reminded_on` date per account makes each tick resumable and idempotent.
- The nudge line is picked from a fixed set of hand-written Persian lines instead of a Gemini call per group. That saves subrequests and the free Gemini quota.

### Mini App (admins only)

- **Serving and auth:** served by the same Worker (static assets). Every API call carries Telegram `initData`, which is HMAC-validated with the bot token, and the user must be an admin. It opens from a menu button or `/app` in a private chat with the bot.
- **Dashboard (layout B, picked by the owner):**
  - live USDT price,
  - KPI tiles: total receivable, total payable, today's volume, pending approvals,
  - top debtors.
- **Clients tab:** each account's balance per asset, open deals, and history. Record a payment, rename, toggle reminder or humor, archive.
- **Deals tab:** all deals with filters by status, type and client. Approve or reject pending ones, edit, cancel.
- **Settings tab:** the admin list, the deviation threshold, and the reminder on/off default.

### Carried over from v1

These are ported as-is:
- the `/deals`, `/balance`, `/id` and `/help` commands (help rewritten for the new natural-language style),
- broadcast (`/broadcast`, `/groups`, `/cancel`; disabled while there are no admins),
- group tracking from updates, including supergroup migration.

## Left to the builder

- **Project layout and libraries:** a Telegram framework like grammY vs raw Bot API calls, the Mini App frontend stack, and the D1 schema details.
- **Testing:** use Workers-compatible tooling (Vitest with the Cloudflare pool). Port the existing parser and ledger tests. Unit-test intent→ledger mapping with recorded Gemini responses instead of live calls.
- **Exact Persian copy** for cards, reminders and help.
- **Retiring the Python code:** delete it from the tree (it stays in git history). Update README and CLAUDE.md.
