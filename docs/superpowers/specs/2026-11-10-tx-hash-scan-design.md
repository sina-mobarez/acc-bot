# Transaction hash scan (USDT on TRON and BSC)

Date: 2026-11-10. Status: draft, waiting for the owner's approval.

## Why

Clients settle deals by sending USDT on chain, then post the transaction hash in their group. Today an admin checks every hash by hand: is it real, did it succeed, did it go to our wallet, how much arrived, how many confirmations does it have. Then the admin matches it to a deal and records a payment that reduces what's left on that deal. The bot should do the checking and prepare the payment card. An admin still approves it.

The same goes for money going out: when we send USDT to a client, the hash should become a pending "we paid" card.

## Goals

- Read a TRON or BSC transaction hash from a group message, look it up on chain, and report the **USDT amount**, the **confirmation count** and the **network fee**.
- Validate the transfer: it succeeded, it's USDT (the official contract on that network), and one side of it is our wallet for that network.
- Turn a valid transfer into a **pending payment card**: RECEIVE when the USDT came into our wallet, PAY when it went out of our wallet. It's linked to a deal when we know which deal.
- Manage the two wallet addresses (one TRON, one BSC) in the Mini App settings.

## Non-goals

- Other coins or networks: TRX itself, ETH, Polygon, USDC, BEP-20 tokens other than USDT.
- Watching wallets for transfers no one posted (no polling, no cron work).
- Re-checking confirmations later or updating a card after it's posted (v1 shows the numbers at scan time).
- Booking the network fee in the ledger. The fee is shown for information only.

## Anti-goals (a failure even if it works)

- A hash that turns into an **approved** payment without an admin. Scans create pending cards only.
- The same transaction counted twice.
- Gemini reading amounts. Every number comes from the chain API and is parsed in code as `Decimal`.
- A transfer between two outside wallets accepted as if it were ours.

## How it behaves

### Spotting a hash

- Hashes are found in code, not by Gemini: `0x` + 64 hex characters (BSC), a bare 64-hex string (TRON first, then BSC if TRON doesn't know it), or a Tronscan or BscScan link that contains one.
- *Builder's call (mine):* in an activated group, a message whose text contains a hash is handled even if it doesn't tag the bot. This costs no Gemini call. Messages without a hash keep today's tag-or-reply rule.
- Strangers still get nothing (`handlers/update.ts` rules unchanged). Private chats don't scan: writes stay group-only, same as today's `PRIVATE_WRITE`.

### Picking the deal (the owner's three paths)

1. **Someone replies to a deal card with the hash.** The payment links to that deal.
2. **An admin replies to a hash message and tags the bot.** The hash comes from the replied-to message. If that message was itself a reply to a deal card, use that deal. Otherwise, go to path 3.
3. **A hash with no deal attached.** The bot replies with the scan result plus buttons for that group's open approved deals that have an open USDT leg in the matching direction (RECEIVE: the client owes USDT; PAY: we owe USDT). It also adds a "no deal / count toward the account" button. *My call:* only an admin can press these buttons. Pressing one creates the pending card, the same as paths 1 and 2.

### Scan result and card

The pending card shows: network, direction, USDT amount, from and to (shortened), confirmations, fee (in TRX or BNB), the hash as a link to the explorer, and the linked deal code if there is one. It uses the normal entry keyboard (✅/❌), with the normal admin-only approval and the compare-and-set `transition`. The entry is a normal PAY/RECEIVE `Trade` with `asset = "USDT"`, so `ledger.ts` (`summarize`, `allocate`) needs no changes.

**Warnings: the card is still made, and the admin decides** (the owner's rule):
- Not final yet: TRON not yet confirmed/solidified; BSC below *my call:* 15 confirmations.
- The amount doesn't equal what's left on the linked deal's USDT leg (less or more).
- The linked deal is not approved, or is already settled.

**Refusals: no card, the bot says why in one Persian line:**
- The hash isn't found (it may be too new: "try again in a minute"), or the transaction failed or reverted.
- No USDT transfer in it, or neither side is our wallet for that network.
- No wallet is set for that network in the Mini App.
- This hash already belongs to a pending or approved entry (show that entry's code). A hash whose entry was rejected or cancelled may be scanned again.
- The explorer or RPC is unreachable or times out ("couldn't check, try again").

If one transaction has several USDT transfers touching our wallet, sum those in the same direction (*my call*).

### Decisions settled after review (my calls unless marked)

- **Clients can trigger a card (the owner's decision).** CLAUDE.md says clients can't write. This feature makes one exception: a client's hash may create a **pending** payment card. Clients still can't approve it, can't press deal-picker buttons, and can't create any other kind of write. Update the CLAUDE.md permission rule to say so.
- **The sender isn't checked against the client.** We don't keep a record of client addresses. The card shows the other side's address, so the admin can tell if a hash looks like it belongs to someone else.
- **Duplicates are checked across all groups.** The refusal names the existing entry's code only if it's in the same group. Otherwise it just says "this transaction is already recorded."
- **The deal doesn't fit the transfer** (the replied-to card is a payment, or has no USDT leg in the scanned direction): don't link it. Fall back to the path 3 picker, with a line saying why.
- **A message with a hash goes to the scan.** It takes over from Gemini and the rest of the text is ignored. Exception: a `#` message still goes to the legacy parser. The scan uses the first hash found.
- **Amounts are stored at full chain precision** (trailing zeros trimmed), not rounded to 2. "Doesn't equal what's left" means a difference of 0.01 USDT or more.
- **One current wallet per network.** If a wallet changes, transfers to the old address are refused. A list of addresses is a possible later addition.

## Chain lookups

- **TRON:** Tronscan API (`apilist.tronscanapi.com`, transaction-info by hash). It gives the status, confirmed flag, confirmations, TRC-20 transfer info and cost/fee. It needs a `TRONSCAN_API_KEY` secret (the free key, `TRON-PRO-API-KEY` header). USDT contract `TR7NHqjeKQxGTCi8q8ZYpYpxjhJ8Jtsk3x`, 6 decimals. Fee is in sun, so ÷ 1e6 gives TRX.
- **BSC:** *my call:* public BSC JSON-RPC (`eth_getTransactionReceipt`, `eth_blockNumber`). It needs no key; BscScan's free API no longer covers BSC. Status from the receipt; amount from `Transfer` logs of USDT `0x55d398326f99059fF775485246999027B3197955` (18 decimals); fee = `gasUsed × effectiveGasPrice` ÷ 1e18 BNB; confirmations = head block − tx block + 1. Make the RPC URL a constant (or an optional `BSC_RPC_URL` var).
- Builder verifies field names against live responses and records real responses as test fixtures.
- Each lookup is 1 to 3 subrequests with a 5 s timeout, like `prices.ts`. Uses `app.fetch` so tests can fake it.
- Address comparison: BSC case-insensitive; TRON base58 exact (or convert both to one form).

## Data

- Migration: store the network and hash on the entry (e.g. `entries.tx_network`, `entries.tx_hash`), with an index for the duplicate check. Builder picks the exact shape.
- Path 3 needs to remember the scan between the reply and the button press (callback_data is 64 bytes, and the hash alone is 64). Store the scan result in a row (a new table, or extend `pending_actions.kind`, whose CHECK currently allows only `'edit'`), and put its id in callback_data. When the button is pressed, re-check that the hash still isn't used.
- Wallets: `settings` keys (e.g. `wallet_tron`, `wallet_bsc`). The Mini App settings tab gets two inputs; the API validates the format (TRON `T…` base58 with 34 characters; BSC `0x` + 40 hex).

## Rules from CLAUDE.md that still hold

Money is `Decimal` (convert from integer base units with decimal.js, never `number`); all chain and user text is HTML-escaped; `Map`/`Object.hasOwn` for anything keyed by external data; status changes only through `transition`. No cron changes.

## Tests

Parser for hash and link extraction; TRON and BSC adapters against recorded fixtures (success, failed, not found, not USDT, not our wallet, multiple transfers); the message flow for all three paths, both directions, duplicates, each warning, missing wallet setting; admin-only deal-picker buttons; Mini App wallet settings validation.

## Left to the builder

Module layout (e.g. `src/chain.ts` plus a handler), exact Persian wording, card layout details, migration shape, and how the deal-picker list is capped (there's a limit on how many buttons fit).
