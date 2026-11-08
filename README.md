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
@bot مقدار معامله ۱۲ رو ۵۰ کن / لغو معامله ۱۲   <- edit or cancel a deal by its code
@bot مانده حساب چنده؟                         <- balance
@bot قیمت تتر و بیت‌کوین چنده؟                 <- live prices (Nobitex, KuCoin)
```

The old `#` syntax still works and does not need an LLM: `#خرید ۱۰۰ تتر رو قیمت ۲۷۵۰۰۰`, `#فروش ۳۰۰ تتر ۳۲۰۰۰۰`, `#دریافت ۵۰ میلیون تومن`, `#sell 100 usdt @ 320000`. Persian and Arabic digits, `هزار`/`میلیون`/`میلیارد` and `k`/`m`/`b` multipliers are accepted. When `تومان`/`تومن` follows the amount, the amount is in toman and the asset amount is `toman ÷ price`.

A deal card shows the numbers and a comparison with the live Nobitex rate. Admins approve with ✅, reject with ❌ or cancel with 🚫. The creator of a pending deal can withdraw it, and cancelling an approved deal asks for confirmation. Admins can also approve and manage deals from the Mini App.

**Roles.** Admins are the Telegram user ids in the `ADMIN_IDS` secret plus anyone added in the Mini App. Being a Telegram group admin grants nothing. Everyone else is a client: clients can only ask (balance, deals, prices) about their own chat and can't create, edit, settle or cancel anything. A client attempting a trade is refused.

**Daily reminder.** At 10:00 Tehran time the bot posts a reminder in each group whose client owes us.

### Commands

- Groups: `/deals [n]` (last n deals, default 15), `/balance`, `/help`, `/id`
- Private chat, admins only: `/app` (open the Mini App), `/broadcast` (send a message to every group; text, photo, file or video; has a delete-everywhere button), `/groups` (the groups the bot is in), `/cancel` (abort a pending broadcast)

Broadcast is admin-only. There is no "anyone" fallback.

### Mini App

Opened from the bot's menu button or `/app`. Tabs: **داشبورد** (totals and KPIs), **مشتری‌ها** (accounts, balances), **معاملات** (deals with approve/reject/cancel), **تنظیمات** (admins and settings).

The Mini App is served from `*.workers.dev`, which is usually filtered in Iran, so admins need a VPN to open it. The bot itself works without one.

## Setup

Needs Node 22+ (wrangler 4 requires it). If npm 10 crashes on peer dependencies, install with `npx npm@11 install`.

```
npx wrangler login
# the D1 database `acc-bot` already exists (id in wrangler.jsonc); on a fresh account: npx wrangler d1 create acc-bot
npm run db:migrate
npx wrangler secret put BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put WEBHOOK_SECRET      # random string, 32+ chars
npx wrangler secret put ADMIN_IDS           # comma-separated Telegram user ids
npm run deploy
curl -X POST -H "X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>" https://acc-bot.<subdomain>.workers.dev/setup
```

`/setup` calls `getMe`, registers the webhook, the command lists and the Mini App menu button, and stores the bot id, username and public URL. Re-run it after changing the URL or the secret. The response should show `webhook: true`. `GET /health/prices` checks the price sources.

Get your Telegram id with `/id` in a private chat with the bot.

## Development

```
npm test                                          # Vitest + @cloudflare/vitest-plugin, runs against a local D1
npx vitest run test/parser.test.ts -t "<name>"    # a single test
npx tsc --noEmit                                  # typecheck
npm run dev                                       # wrangler dev; copy .dev.vars.example to .dev.vars and fill it in
```
