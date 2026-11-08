# acc-bot

Telegram bot (@Arian_Dealer_bot) that records trades posted in client groups. Write a trade in the group and the bot replies with a Persian deal card that has **✅ تایید / ❌ رد / 🚫 لغو** buttons. Every deal is stored in SQLite. Approved deals are also written to Google Sheets when it's configured. The client name comes from the group title.

## Syntax

```
#خرید ۱۰۰ تا تتر رو قیمت ۲۷۵۰۰۰ تومن
#فروش ۳۰۰ تا تتر رو قیمت ۳۲۰۰۰۰
#خرید ۲ میلیون تتر ۲۷۵ هزار بانک ملت      <- text after the price is a note
#sell 100 usdt @ 320000
#خرید ۵۰۰ میلیون تومان به قیمت ۲۶۴۰۰۰       <- toman amount: 500,000,000 ÷ 264,000 = 1,893.94 USDT
#فروش ۱ میلیارد تومن تتر به قیمت ۲۶۵۰۰۰      <- works the same for sell
```

When `تومان`/`تومن` follows the amount, the amount is in toman. The asset amount is `toman ÷ price`, rounded to 2 decimals for USDT, and the toman total is kept exact. A price is required, and the bot replies with an example if it's missing.

### Payments

Everything is written from **our** side:

```
#دریافت ۵۰ میلیون تومن کارت به کارت   <- client paid us (RECEIVE)
#پرداخت ۲۷٬۵۰۰٬۰۰۰ تومن                <- we paid the client (PAY)
#دریافت ۱۰۰ تتر / #ارسال ۲۰۰ تتر       <- tether delivered to us / sent by us
```

Payments use the same card and approval flow as trades. Without an asset word, the amount is in toman.

- Every trade or payment message **must start with `#`**, followed by `خرید`/`buy`, `فروش`/`sell`, `پرداخت`/`ارسال`/`pay` or `دریافت`/`receive`. Messages without `#` are ignored. Slash commands are unchanged.
- Multipliers: `هزار`, `میلیون`, `میلیارد`, `k`, `m`/`mil`/`million`, `b`.
- Price keywords: `رو قیمت`, `به قیمت`, `قیمت`, `فی`, `نرخ`, `@`, `at`. A bare number after the asset also works.
- Persian and Arabic digits and `٬`/`٫` separators are accepted. The asset defaults to تتر (USDT).

## Commands (in a client group)

- `/deals [n]`: the last n deals (default 15, max 40) with their status
- `/balance`: who owes whom, per asset, from approved trades and payments (BUY: client owes the asset and we owe the toman; SELL: the reverse; PAY/RECEIVE settle it), plus trade stats and payment totals
- `/id`: your Telegram ID (for `APPROVER_IDS`)

## Broadcasting (private chat with the bot, `APPROVER_IDS` only)

- `/broadcast`: the bot asks for a message. Send text, a photo, a file or a video, and it's copied as-is, formatting included. You get a confirmation with the group count, then a report showing sent and failed groups, with a **🗑 حذف از همه گروه‌ها** button (Telegram allows deleting within 48h). You can also reply to an existing message with `/broadcast`.
- `/groups`: the groups the bot is in (👑 admin, 👤 member).
- `/cancel`: abort a pending broadcast.

Broadcasting is disabled while `APPROVER_IDS` is empty. A private chat has no admins to check, so leaving it open would let anyone message every client group.

Telegram has no API to list a bot's groups, so the bot records them in the `chats` table. Entries come from join, leave and promote events and from any message it sees. At startup it adds groups from past deals and rechecks its status in each one. Groups that removed the bot are skipped, and a group upgraded to a supergroup keeps its deals. Every broadcast and each per-group delivery is stored in `broadcasts` / `broadcast_messages`.

## Deal lifecycle

`pending` → ✅ `approved` (written to the sheet) → 🚫 `cancelled` (asks for confirmation and sets the sheet row's status to «لغو شده»)
`pending` → ❌ `rejected` | 🚫 `cancelled` (the creator or an approver can cancel)

Approve, reject and cancel-after-approval are limited to `APPROVER_IDS`. If that's empty, any group admin can do them.

## Deployment (pingi-stage)

The bot lives in `/opt/acc-bot` as its own compose stack. Telegram is blocked from that host, so the bot joins `pingi-bot_botnet` and uses pingi-bot's sing-box container `pingi-xray` as `socks5h://pingi-xray:1080`. If pingi-bot's stack is down, this bot can't reach Telegram.

```
rsync -a --exclude .venv --exclude __pycache__ ./ pingi-stage:/opt/acc-bot/
ssh pingi-stage 'cd /opt/acc-bot && docker compose up -d --build && docker compose logs -f bot'
```

The DB lives on the `acc-bot_accdata` volume at `/data/deals.db`.

### Google Sheets

1. In Google Cloud, enable the **Google Sheets API**, create a **Service Account**, and download its JSON key.
2. Copy the key to `pingi-stage:/opt/acc-bot/secrets/credentials.json`.
3. Share the sheet (Editor) with the service account's `client_email`.
4. Set `SHEET_ID` in `/opt/acc-bot/.env`, then run `docker compose up -d`.

The `Deals` tab, its Persian header row and right-to-left layout are created automatically.

## Tests

```
docker run --rm acc-bot-bot sh -c "pip install -q pytest && python -m pytest -q tests"
```
