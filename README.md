# acc-bot v2

A Telegram assistant for recording trades and payments with clients. It runs as a single Cloudflare Worker on D1. In a client group you tag the bot (or reply to it) and write in plain Persian. It understands the message, drafts a deal card with ✅ / ❌ / 🚫 buttons, and nothing is recorded until an admin approves it. A Mini App gives admins a dashboard, client accounts, deals and settings.

## Talking to the bot

In a client group, tag `@bot` or reply to one of its messages, then write normally:

```
@bot خرید ۱۰۰ تتر رو ۲۷۵                  <- trade: we bought 100 USDT at 275,000 toman
@bot فروختیم ۵۰۰ میلیون تومن تتر ۲۶۵ هزار   <- toman-amount trade: USDT = toman ÷ price
@bot ۵۰ میلیون تومن دریافت کردیم پیگیری ۱۲۳۴۵۶  <- payment received from the client, with its tracking code
@bot ۲۷ میلیون تومن پرداخت کردیم            <- payment sent to the client; the bot asks for the tracking code
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

**Transaction hash scan.** When someone posts a USDT transaction hash (TRON or BSC, bare or as a Tronscan/BscScan link) in a client group, the bot looks it up on chain. It doesn't need to be tagged, and Gemini isn't used. It checks that the transfer succeeded, is official USDT, and went to or came from our wallet for that network. Then it shows the amount, the confirmations and the network fee, and makes a pending payment card: «دریافت» when the USDT came into our wallet, «پرداخت» when it went out. An admin still has to approve the card.
- Reply to a deal card with the hash, and the payment is linked to that deal.
- Post the hash on its own, or tag the bot on someone else's hash message, and the bot lists the group's open deals that still owe USDT that way, plus «بدون معامله». Only an admin can pick.
- The card warns when the transfer isn't final yet (TRON not confirmed, BSC under 15 confirmations), when the amount differs from what's left on the deal by 0.01 USDT or more, or when the deal isn't approved or is already settled. The admin decides.
- A failed transfer, one that doesn't touch our wallet, an unknown hash (posted too early: send it again in a minute) or a hash that's already recorded gets a one-line refusal and no card.

Clients can post hashes too. This is the one way a client can cause a card, and it stays pending until an admin approves it. Set the two wallet addresses in the Mini App settings; a network with no wallet isn't checked.

**Tracking code / transaction hash.** A payment or receipt is never saved without its reference: the bank tracking code (کد پیگیری) for toman, the transaction hash for crypto. Write it in the message (`… پیگیری ۱۲۳۴۵۶`, or paste the hash). If it is missing, the bot posts a one-line question and saves nothing; an admin replies to that question with the code and the pending card appears. The Mini App's payment form refuses without it too. Exceptions: payments created by «تسویه» (add the code afterwards: `@bot کد پیگیری D-00015 ۱۲۳۴۵۶`, or reply to a payment card with the code), scanned transactions (the hash is already there), and direct bank moves in the private chat. A payment written as a reply to an approved deal's card is linked to that deal.

**Cards are short.** A card shows what it is, the numbers, the bank, the code or hash, the linked deal, the note and the status. It does not show who recorded or approved it, the date, or a joke; those stay in the database and the Mini App. Jokes (when «شوخی‌ها» is on for a group) only follow answers to questions such as balance or price.

**Bank accounts.** Add our own toman bank accounts (سامان، گردشگری، …) in the Mini App's «بانک‌ها» tab. A bank's balance is never typed in or stored: it is the approved toman payments recorded on it plus its manual moves.

- In a client group, name the bank in a toman payment: `@bot ۵۰ میلیون تومن دریافت شد به سامان`, `#پرداخت ۲۰ میلیون تومن گردشگری`, or `@bot تسویه کن به سامان`. The card shows the bank. Once an admin approves it, money received from the client raises that bank and money paid to the client lowers it; cancelling the payment takes it back. A bank the bot doesn't know gets a question, not a card.
- In the private chat (admins), a toman payment is a direct move on a bank with no client and no approval step: `واریز ۵۰ میلیون به سامان` adds, `برداشت ۲۰ میلیون از سامان` takes away, and the bot answers with the new balance. Undo one in the Mini App (the bank's «گردش حساب»).
- Balances show only in the private chat (`/banks` or «موجودی بانک‌ها») and in the Mini App. They are never posted in a group, and clients cannot ask for them.

### Commands

- Groups: `/deals [n]` (last n deals, default 15), `/balance`, `/help`, `/id`
- Private chat, admins only: `/app` (open the Mini App), `/banks` (our bank balances), `/broadcast` (send a message to every group; text, photo, file or video; sending starts within about a minute, from the cron; has a delete-everywhere button), `/groups` (the groups the bot is in), `/cancel` (abort a pending broadcast)

Broadcast is admin-only. There is no "anyone" fallback.

### Mini App

Opened from the bot's menu button or `/app`. Tabs: **داشبورد** (totals and KPIs), **مشتری‌ها** (accounts, balances), **معاملات** (deals with approve/reject/cancel), **بانک‌ها** (our bank accounts: balances, manual deposit/withdrawal, history, rename, delete), **تنظیمات** (admins, the price-deviation threshold, the reminder default and the TRON/BSC wallets for the hash scan). The «پنل مدیریت» menu button appears only in admins' private chats; everyone else sees the command menu.

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
npx wrangler secret put TRONSCAN_API_KEY    # optional: a free Tronscan key, only for higher rate limits
npm run deploy
curl -X POST -H "X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>" https://acc-bot.<subdomain>.workers.dev/setup
```

On a fresh Cloudflare account, `wrangler d1 create acc-bot` prints a `database_id`; put it in the `d1_databases` entry of `wrangler.jsonc` before migrating or deploying (the committed id belongs to the existing deployment).

Migrations live in `migrations/`: `0001_init.sql` (schema), `0002_broadcast_work_index.sql` (indexes for the every-minute broadcast check) `0003_account_activation.sql` (the `activated` flag; groups that already have entries start activated) `0004_tx_scan.sql` (transaction columns on entries, the one-live-entry-per-hash index, and `tx_scans` for scans waiting on a deal pick) `0005_banks.sql` (our bank accounts, their manual moves, and the bank on a payment) and `0006_entry_ref.sql` (the tracking code / hash on an entry, and `payment_drafts` for payments waiting on one). `npm run db:migrate` applies all of them in order and skips the ones already applied, so run it after every pull that adds one.

`WEBHOOK_SECRET` is sent by Telegram in a header, so it may only use `A-Z`, `a-z`, `0-9`, `_` and `-` (1 to 256 characters). `openssl rand -hex 32` gives a good one.

`/setup` calls `getMe`, registers the webhook and the command lists, keeps the default menu button as the command menu and sets the Mini App button in each admin's private chat, and stores the bot id, username and public URL. Admins added later in the Mini App get the button right away. Re-run it after changing the URL or the secret. The response should show `webhook: true`. `GET /health/prices` checks the price sources.

The hash scan uses Tronscan (`apilist.tronscanapi.com`, works without a key) and the public BSC node `https://bsc-dataseed.bnbchain.org`; set a `BSC_RPC_URL` var in `wrangler.jsonc` to use another node.

Get your Telegram id with `/id` in a private chat with the bot.

### Moving to a new bot (new username)

A bot's username can't be changed, but the data doesn't belong to the bot: it is in D1, keyed by Telegram chat ids, which stay the same. To switch, create the new bot in @BotFather and then:

```
npx wrangler secret put BOT_TOKEN           # paste the NEW bot's token
curl -X POST -H "X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>" https://acc-bot.<subdomain>.workers.dev/setup
```

`/setup` stores the new bot's id and username and points its webhook here. Then:

1. Before switching, approve or reject every pending card (or do it afterwards in the Mini App): buttons on cards the old bot sent stop working, and the new bot can't edit those cards.
2. Add the new bot to every client group and have an admin send one message there. Balances and deals appear as before. Turn off privacy mode in @BotFather (`/setprivacy`) if the old bot had it off, so hash scans keep working.
3. Each admin presses Start on the new bot (a bot can't message someone who hasn't), and opens the Mini App from it.
4. Remove the old bot from the groups, and revoke its token or delete it in @BotFather.

Broadcasts sent by the old bot can no longer be deleted from the bot.

## Development

```
npm test                                          # Vitest + @cloudflare/vitest-plugin, runs against a local D1
npx vitest run test/parser.test.ts -t "<name>"    # a single test
npx tsc --noEmit                                  # typecheck
npm run dev                                       # wrangler dev; copy .dev.vars.example to .dev.vars and fill it in
```
