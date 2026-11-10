# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram assistant (Cloudflare Worker, TypeScript, D1) for a trading office. In client groups, admins and clients talk to it in plain Persian (tag or reply); `#`-prefixed messages use the strict legacy syntax. Trades and payments become deal cards that an admin must approve. A Mini App gives admins a dashboard. All user-facing text is Persian. README.md has the user guide and deployment steps. The old Python v1 is gone (see git history).

## Commands

```
npm test                                          # Vitest + @cloudflare/vitest-plugin (local D1, migrations/ applied)
npx vitest run test/parser.test.ts -t "<name>"    # a single test
npx tsc --noEmit                                  # typecheck; keep it clean
npm run dev                                       # wrangler dev, secrets from .dev.vars (see .dev.vars.example)
```

Use Node 22+ (wrangler 4 needs it; a local copy may live in gitignored `.tools/`). If npm 10 crashes on peer deps, use `npx npm@11 install`. Don't run `wrangler deploy`, `secret` or remote `d1` commands unless the owner asks.

## Architecture

One Worker, `src/index.ts`:
- `POST /tg`: Telegram webhook, checked via the `X-Telegram-Bot-Api-Secret-Token` header. It acks immediately and does the work in `ctx.waitUntil`; `update_id` is deduped in D1.
- `POST /setup`: same secret header. Calls getMe, setWebhook, commands and the menu button, and stores `bot_id`, `bot_username` and `public_url` in settings.
- `GET /health/prices`; `/api/*`: the Mini App admin API (`Authorization: tma <initData>`, validated in `miniapp/auth.ts`); everything else is static assets (Mini App at `/app/`, from `public/app`).
- Cron every minute (`cron.ts`): daily debtor reminders at 10:00 Tehran (UTC+03:30), broadcast batches, and pruning of processed updates. Each step is isolated (a failure is logged, the others still run). Broadcasts are sent only from the cron, never from the webhook.
- D1 database `acc-bot` (binding `DB`), schema in `migrations/`.

Message flow: `handlers/update.ts` (dedupe, routing) → `handlers/message.ts` → either `parser.ts` (`#` grammar) or `nlu.ts` (Gemini) → `intent.ts` turns the NLU output plus the sender's role into an `Action` → the handler executes it and renders with `cards.ts`. `handlers/callback.ts` runs the card buttons, `handlers/commands.ts` the slash commands. A group message with a USDT tx hash skips the NLU and goes to `handlers/txscan.ts` (routed in `update.ts`); its duplicate guard is the partial unique index `entries_tx_active`.

Other modules: `money.ts` (Decimal, normalize), `trade.ts` (types), `ledger.ts` (`summarize` plus FIFO `allocate` for settlement), `db.ts` (all queries), `telegram.ts` (API client), `prices.ts` (Nobitex rial÷10 to toman, KuCoin), `chain.ts` (find a tx hash; Tronscan and BSC JSON-RPC lookups), `txscan.ts` (pure scan rules: direction, wallets, warnings), `jokes.ts`, `broadcast.ts`, `reminders.ts`, `miniapp/api.ts`. `app.ts` defines the `App` dependency bag handlers receive (tests substitute fakes from `test/fakes.ts`).

## Rules to keep

- **Nothing is approved without an admin.** Only an admin's ✅ or a Mini App action moves a deal to approved. Bot text, NLU output and clients never do.
- **Gemini never computes numbers.** `nlu.ts` only extracts text fields; amounts, rates and totals are parsed and calculated in code.
- **Money is `Decimal`** (decimal.js, precision 40) in memory and TEXT in D1. Never use a JS `number` for money. A toman-denominated trade (`tomanTotal`) must have a rate.
- **Ledger sign convention** is from our side: `owed > 0` means the client owes us. BUY: client owes the asset, we owe toman. SELL: the reverse. PAY is `+`, RECEIVE is `−`.
- **Status changes only through the compare-and-set `transition`** in `db.ts`. It is the guard against double taps and races.
- **Permissions.** Clients see only their own chat and cannot write. One exception: a client's transaction hash may create a *pending* scan card (`handlers/txscan.ts`); clients still cannot approve it or press the deal-picker buttons. Admins are the `ADMIN_IDS` secret (may be unset) plus the `admins` table; Telegram group-admin status grants nothing. Broadcast never falls back to "anyone".
- **Strangers get nothing.** In a private chat a non-admin is answered only for `/id`, `/help` and `/start`; everything else is dropped in `handlers/update.ts` before any Gemini or Nobitex call. A group serves anyone only once `accounts.activated = 1`, set when an admin speaks there or adds the bot (sticky). `listAccounts` and broadcast recipients include activated accounts only, so reminders, broadcasts, `/groups` and the Mini App skip the rest.
- **Edits are deltas.** An edit proposal stores only the requested changes; applying it re-runs `applyTradeEdit` on the entry's current trade.
- **Own-key-safe lookups.** Use `Map` or `Object.hasOwn` for anything keyed by user or LLM text (never `obj[key]` on a plain object).
- **Escape output.** All user and LLM text going into HTML messages is HTML-escaped.
- **Free-plan budget.** Free Workers allow ~50 external subrequests and ~50 D1 queries per invocation. The cron jobs (reminders, broadcast, prune) share one per-invocation `Budget` (`INVOCATION_BUDGET` in `src/constants.ts`); each Telegram call and D1 statement takes from it. Keep new cron work inside it.
