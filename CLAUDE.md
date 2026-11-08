# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram bot (python-telegram-bot v22, async) that turns `#`-prefixed Persian/English trade and payment messages in client groups into deal cards with approve/reject/cancel buttons. Deals live in SQLite, and approved ones are mirrored to Google Sheets when that's configured. All user-facing text is Persian. README.md has the full message syntax, the commands and the deployment steps.

## Commands

```
uv run pytest -q                                   # all tests (uv creates .venv; pytest is in the dev group)
uv run pytest -q tests/test_parser.py::test_name   # a single test
uv run python -m accbot.main                       # run locally (needs BOT_TOKEN in .env; see .env.example)
```

In the Docker image (as the README shows): `docker run --rm acc-bot-bot sh -c "pip install -q pytest && python -m pytest -q tests"`.

There's no linter or formatter config. `requirements.txt` (used by the Dockerfile) duplicates `pyproject.toml` dependencies, so update both together.

## Architecture

`accbot/main.py` wires everything up. It reads env at import time, creates module-level singletons (`store`, `sheet`, `broadcaster`) and holds the group handlers plus the deal button state machine.

- **parser.py**: pure parsing into a frozen `Trade` dataclass. It's the only place that knows the syntax. Text goes through `normalize()` first (Persian/Arabic digits and separators to ASCII, Arabic ی/ک, ZWNJ to space). `parse_message` returns `None` for non-deal text (anything without a leading `#`) and raises `TradeError` with a Persian message for a recognizable deal it can't record. All amounts are `Decimal`. A toman-denominated trade keeps the exact `toman_total` and rounds `amount` per `PRECISION`. Toman is the asset code `IRT` (`TOMAN`).
- **storage.py**: one synchronous sqlite3 connection in autocommit mode. `SCHEMA` is `CREATE IF NOT EXISTS`, and new `deals` columns go in the `MIGRATIONS` list (an ALTER TABLE runs at startup), not in place. Decimals are stored as TEXT. `transition(id, from, to, **fields)` is a compare-and-set UPDATE that returns whether it applied. It's the concurrency guard against double taps, so don't change a status without it.
- **Deal lifecycle**: `pending → approving → approved → cancelled`, or `pending → rejected | cancelled`. `approving` is a lock held while the Sheets write runs. If the write fails, the deal rolls back to `pending`. Callback data is `<action>:<deal_id>` with actions `ok`, `no`, `cx` (cancel), `cy`/`cn` (confirm or abort cancelling an approved deal).
- **ledger.py**: `summarize()` builds the `/balance` account from approved trades. The sign convention is from our side: `owed > 0` means the client owes us. BUY adds the asset and subtracts toman, SELL does the reverse, PAY is `+`, RECEIVE is `-`.
- **card.py**: HTML rendering (deal card, `/deals` list, balance), inline keyboards and Jalali dates. Messages use `ParseMode.HTML`.
- **sheets.py**: gspread is synchronous, so every call is wrapped in `asyncio.to_thread`. It's enabled only when `SHEET_ID` is set and the credentials file exists. It creates the worksheet, header and RTL layout on first use, and finds rows by deal code in column 1 for status updates.
- **broadcast.py**: `Broadcaster.register()` adds handlers in negative groups. Group -2 is a `TypeHandler` that records every group it sees in the `chats` table, because Telegram can't list a bot's chats. Group -1 grabs the next private message while a broadcast is waiting, before deal parsing runs. Handles supergroup migration (`migrate_chat`), rate limiting (`SEND_DELAY`, `RetryAfter`) and deleting a broadcast everywhere. At startup, `refresh()` rechecks the bot's status in every known chat.

## Permissions (security-relevant)

- With `APPROVER_IDS` set, only those users can approve, reject or cancel an approved deal. When it's empty, any group admin can, and in a private chat anyone can.
- Broadcasting **never** falls back: with `APPROVER_IDS` empty, it's disabled (`Broadcaster.allowed`). Keep it that way.
- The creator of a pending deal can withdraw it, and so can an approver.

## Deployment notes

It deploys by rsync to `pingi-stage:/opt/acc-bot` and runs with `docker compose up -d --build`. Telegram is blocked on that host, so the container joins the external `pingi-bot_botnet` network and goes through `socks5h://pingi-xray:1080`. It depends on pingi-bot's stack running. The DB is `/data/deals.db` on the `acc-bot_accdata` volume.
