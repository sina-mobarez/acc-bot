# acc-bot v2

A Telegram assistant for recording trades and payments with clients. It runs as a single Cloudflare Worker on D1. In a client group you tag the bot (or reply to it) and write in plain Persian. It understands the message, drafts a deal card with ✅ / ❌ / 🚫 buttons, and nothing is recorded until an admin approves it. A Mini App gives admins a dashboard, client accounts, deals and settings.

## Talking to the bot

In a client group, tag `@bot` or reply to one of its messages, then write normally:

```
@bot خرید ۱۰۰ تتر رو ۲۷۵                  <- trade: we bought 100 USDT at 275,000 toman
@bot فروختیم ۵۰۰ میلیون تومن تتر ۲۶۵ هزار   <- toman-amount trade: USDT = toman ÷ price
@bot ۵۰ میلیون تومن کارت به کارت دریافت کردیم  <- payment received from the client
@bot ۲۷ میلیون تومن پرداخت کردیم            <- payment sent to the client
@bot تسویه                                   <- reply to a deal card: settle it against recorded payments
@bot مقدار D-00012 رو ۵۰ کن / لغو D-00012      <- edit or cancel a deal by its card code
@bot مانده حساب چنده؟                         <- balance: one line per currency (minus = بدهکار, plus = بستانکار)
@bot قیمت تتر و بیت‌کوین چنده؟                 <- live prices (Nobitex, KuCoin)
```

The old `#` syntax still works and does not need an LLM: `#خرید ۱۰۰ تتر رو قیمت ۲۷۵۰۰۰`, `#فروش ۳۰۰ تتر ۳۲۰۰۰۰`, `#دریافت ۵۰ میلیون تومن`, `#sell 100 usdt @ 320000`. Persian and Arabic digits, `هزار`/`میلیون`/`میلیارد` and `k`/`m`/`b` multipliers are accepted. When `تومان`/`تومن` follows the amount, the amount is in toman and the asset amount is `toman ÷ price`.

A deal card shows the numbers (no Nobitex price; a rate far from Nobitex only changes the joke). Admins approve with ✅, reject with ❌ or cancel with 🚫. Only admins can use these buttons, and cancelling an approved deal asks for confirmation. Admins can also approve and manage deals from the Mini App.

**Roles.** Admins are the Telegram user ids in the `ADMIN_IDS` secret plus anyone added in the Mini App. Being a Telegram group admin grants nothing. Everyone else is a client: clients can only ask (balance, deals, prices) about their own chat and can't create, edit, settle or cancel anything. A client attempting a trade is refused. An edit is a proposal with its own ✅ button; applying it changes only the fields it asked for, on top of any edits made since.

**Strangers.** The bot ignores people it doesn't know. In a private chat a non-admin gets an answer only to `/id` and `/help` (so you can find your id before `ADMIN_IDS` is set); everything else is silently ignored. A group becomes a client account only once an admin has spoken in it: **after adding the bot to a new client group, an admin sends any message there once** (adding the bot as an admin also counts). Until then the bot answers no one in that group, and the group is left out of reminders, broadcasts, `/groups` and the Mini App.

**Daily reminder.** At 10:00 Tehran time the bot posts a reminder in each group whose client owes us. Each group can turn it off in the Mini App; the settings tab has the on/off default for groups added later.

### Commands

- Groups: `/deals [n]` (last n deals, default 15), `/balance`, `/help`, `/id`
- Private chat, admins only: `/app` (open the Mini App), `/broadcast` (send a message to every group; text, photo, file or video; sending starts within about a minute, from the cron; has a delete-everywhere button), `/groups` (the groups the bot is in), `/cancel` (abort a pending broadcast)

Broadcast is admin-only. There is no "anyone" fallback.

### Mini App

Opened from the bot's menu button or `/app`. Tabs: **داشبورد** (totals and KPIs), **مشتری‌ها** (accounts, balances), **معاملات** (deals with approve/reject/cancel), **تنظیمات** (admins, the price-deviation threshold and the reminder default). The «پنل مدیریت» menu button appears only in admins' private chats; everyone else sees the command menu.

Deals, payments and customers can be deleted from the Mini App. Deletion is permanent (rows are removed, not hidden) and asks for two confirmations; a deleted deal's payments stay and fall back to FIFO.

The Mini App is served from `*.workers.dev`, which is usually filtered in Iran, so admins need a VPN to open it. The bot itself works without one.

## Setup

Needs Node 22+ (wrangler 4 requires it). If npm 10 crashes on peer dependencies, install with `npx npm@11 install`.

```
npx wrangler login
npx wrangler d1 create acc-bot              # fresh Cloudflare account only; paste the printed database_id into wrangler.jsonc
npm run db:migrate                          # applies every migration in migrations/ that hasn't run yet
npx wrangler secret put BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put WEBHOOK_SECRET      # e.g. the output of: openssl rand -hex 32
npx wrangler secret put ADMIN_IDS           # comma-separated Telegram user ids
npm run deploy
curl -X POST -H "X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>" https://acc-bot.<subdomain>.workers.dev/setup
```

On a fresh Cloudflare account, `wrangler d1 create acc-bot` prints a `database_id`; put it in the `d1_databases` entry of `wrangler.jsonc` before migrating or deploying (the committed id belongs to the existing deployment).

Migrations live in `migrations/`: `0001_init.sql` (schema), `0002_broadcast_work_index.sql` (indexes for the every-minute broadcast check) and `0003_account_activation.sql` (the `activated` flag; groups that already have entries start activated). `npm run db:migrate` applies all of them in order and skips the ones already applied, so run it after every pull that adds one.

`WEBHOOK_SECRET` is sent by Telegram in a header, so it may only use `A-Z`, `a-z`, `0-9`, `_` and `-` (1 to 256 characters). `openssl rand -hex 32` gives a good one.

`/setup` calls `getMe`, registers the webhook and the command lists, keeps the default menu button as the command menu and sets the Mini App button in each admin's private chat, and stores the bot id, username and public URL. Admins added later in the Mini App get the button right away. Re-run it after changing the URL or the secret. The response should show `webhook: true`. `GET /health/prices` checks the price sources.

Get your Telegram id with `/id` in a private chat with the bot.

## Development

```
npm test                                          # Vitest + @cloudflare/vitest-plugin, runs against a local D1
npx vitest run test/parser.test.ts -t "<name>"    # a single test
npx tsc --noEmit                                  # typecheck
npm run dev                                       # wrangler dev; copy .dev.vars.example to .dev.vars and fill it in
```
