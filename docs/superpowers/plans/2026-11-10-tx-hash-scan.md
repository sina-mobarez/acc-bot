# Transaction Hash Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A USDT transaction hash (TRON or BSC) posted in a client group is looked up on chain, validated against our wallet, and turned into a pending PAY/RECEIVE card (linked to a deal when known) showing amount, confirmations and fee.

**Architecture:** `src/chain.ts` finds hashes in text and talks to Tronscan / BSC JSON-RPC. `src/txscan.ts` is pure logic (direction, refusals, warnings, wallet validation). `src/handlers/txscan.ts` runs the flow and the deal-picker callback. Entries get tx columns, and a partial unique index on them is the duplicate guard. A `tx_scans` table holds path-3 scans until an admin picks a deal.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, decimal.js, Vitest + @cloudflare/vitest-plugin.

**Spec:** `docs/superpowers/specs/2026-11-10-tx-hash-scan-design.md`

## Global Constraints

- Money is `Decimal`; on-chain integers convert with `new Decimal(intString).div(10 ** decimals)` (decimal.js accepts `0x…` hex for BSC log data). Never `Number()` an amount or fee.
- TRON USDT contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, 6 decimals. BSC USDT `0x55d398326f99059fF775485246999027B3197955`, 18 decimals. ERC-20 Transfer topic `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`.
- TRON fee (TRX) = (`cost.energy_fee` + `cost.net_fee` + `cost.multi_sign_fee` + `cost.memoFee`) ÷ 1e6. BSC fee (BNB) = `gasUsed × effectiveGasPrice` ÷ 1e18.
- Final: TRON `confirmed === true`; BSC confirmations ≥ 15 (`BSC_FINAL_CONFIRMATIONS = 15`).
- Amount mismatch warning when |amount − remaining| ≥ 0.01 USDT. Amounts stored at full chain precision (`toFixed()` of the Decimal, trailing zeros trimmed by decimal.js).
- Tronscan: `GET https://apilist.tronscanapi.com/api/transaction-info?hash=<hash>`; unknown hash returns `{}` (HTTP 200). Header `TRON-PRO-API-KEY` only when `env.TRONSCAN_API_KEY` is set.
- BSC: `POST` JSON-RPC to `env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org"`, one batch request `[eth_getTransactionReceipt, eth_blockNumber]`; unknown hash → receipt `result: null`.
- 5 s timeout per request (`AbortSignal.timeout(5000)`), all through `app.fetch`.
- Settings keys `wallet_tron`, `wallet_bsc`. TRON wallet: base58 `T` + 33 chars (`/^T[1-9A-HJ-NP-Za-km-z]{33}$/`). BSC wallet: `/^0x[0-9a-fA-F]{40}$/`, stored lowercase. Compare BSC addresses lowercase, TRON exact.
- Hash storage: TRON = 64 lowercase hex, no prefix; BSC = `0x` + 64 lowercase hex.
- All user/chain text in HTML is passed through `escapeHtml`. All user-facing text is Persian.
- Status changes only via `transition`; nothing approved without an admin; clients may trigger a pending scan card only (no picker presses).

## Review Focus

1. Hash wrapped in text or a link (`https://tronscan.org/#/transaction/<hash>`, `https://bscscan.com/tx/0x…`, Persian text around it, ZWNJ/RTL marks): must still be found. Tests in Task 2.
2. The same hash posted twice at once (two webhooks race): exactly one entry. The unique index makes the second insert throw, and that is mapped to the duplicate refusal. Test in Task 1 (the index) and Task 5 (the message).
3. BSC wallet saved checksummed (mixed case) and the log addresses lowercase: must match. Tests in Task 3 and Task 6.
4. A hash posted seconds after sending (not indexed yet): "not found, try again in a minute", nothing stored, and posting again later works. Test in Task 5.
5. Picker button pressed twice, or pressed after the same hash got a card another way: one card only, and the second press gets the duplicate answer. Test in Task 5.

## File Structure

- Create `migrations/0004_tx_scan.sql`: entry tx columns, unique index, `tx_scans` table.
- Modify `src/db.ts`: `TxMeta` on `Entry`/`NewEntry`, `findActiveByTx`, tx-scan CRUD, `DuplicateTxError`.
- Create `src/chain.ts`: hash extraction, `lookupTron`, `lookupBsc`, `lookupTx`.
- Create `src/txscan.ts`: `parseWallet`, `classify`, `dealFit`, `warnings`.
- Modify `src/cards.ts`: tx lines in `renderEntry`; `renderTxScan`, `txPickerKeyboard`.
- Create `src/handlers/txscan.ts`: `txScanTarget`, `handleTxScan`, `handleTxPick`.
- Modify `src/handlers/update.ts` (routing), `src/handlers/callback.ts` (`tp:` callbacks), `src/handlers/message.ts` (export `send`, `sendCard`, `who`).
- Modify `src/miniapp/api.ts`, `public/app/app.js`: wallet settings.
- Modify `env.d.ts`, `.dev.vars.example`, `README.md`, `CLAUDE.md`.
- Tests: `test/chain.test.ts`, `test/txscan.test.ts`, `test/txscan-flow.test.ts`, plus additions to `test/db.test.ts`, `test/cards.test.ts`, `test/miniapp.test.ts`. Fixtures are already in `test/fixtures/` (real responses from 2026-11-10).

---

### Task 1: Schema and DB access

**Files:**
- Create: `migrations/0004_tx_scan.sql`
- Modify: `src/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Produces:
  - `type Network = "TRON" | "BSC"` (export from `src/chain.ts` in Task 2; for now define it in `db.ts` and have `chain.ts` re-export it, or the reverse. Pick one and keep it as the single source.)
  - `interface TxMeta { network: Network; hash: string; counterparty: string; confirmations: number; final: boolean; fee: Decimal; feeAsset: "TRX" | "BNB"; warnings: string[] }`
  - `Entry.tx: TxMeta | null`; `NewEntry.tx?: TxMeta | null`
  - `class DuplicateTxError extends Error`. `createEntry` throws it when the unique index rejects the insert (D1 error message contains `UNIQUE constraint failed`).
  - `findActiveByTx(db, network: Network, hash: string): Promise<Entry | null>` returns the pending or approved entry with that tx.
  - `interface TxScan { id: number; chatId: number; side: "PAY" | "RECEIVE"; amount: Decimal; meta: TxMeta; createdBy: string; createdById: number; sourceMsgId: number | null; createdAt: string; status: "pending" | "used" }`
  - `createTxScan(db, s: Omit<TxScan, "id" | "status">): Promise<number>`, `getTxScan(db, id): Promise<TxScan | null>`, `takeTxScan(db, id): Promise<TxScan | null>` (CAS pending→used, `RETURNING *`), `releaseTxScan(db, id): Promise<void>` (used→pending).

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE entries ADD COLUMN tx_network TEXT;
ALTER TABLE entries ADD COLUMN tx_hash TEXT;
ALTER TABLE entries ADD COLUMN tx_json TEXT;
CREATE UNIQUE INDEX entries_tx_active ON entries (tx_network, tx_hash)
  WHERE tx_hash IS NOT NULL AND status IN ('pending', 'approved');
CREATE TABLE tx_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('PAY','RECEIVE')),
  amount TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_id INTEGER NOT NULL,
  source_msg_id INTEGER,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used'))
);
```

`tx_json` holds `TxMeta` with `fee` as a string. Write `txMetaToJson` / `txMetaFromJson` helpers next to `tradeToJson`.

- [ ] **Step 2: Write failing tests in `test/db.test.ts`**
  - `createEntry with tx round-trips TxMeta` checks that `getEntry(...).tx` deep-equals the input (`fee` compared with `.eq`), and that an entry without tx has `tx === null`.
  - `second active entry with the same tx throws DuplicateTxError`.
  - `same tx allowed again after the first is rejected` (use `transition` pending→rejected, then create succeeds).
  - `findActiveByTx finds pending/approved only` returns null for a rejected one.
  - `takeTxScan claims once` (second call null); `releaseTxScan makes it claimable again`.

- [ ] **Step 3: Run `npx vitest run test/db.test.ts`.** Expected: the new tests FAIL.

- [ ] **Step 4: Implement the db.ts changes listed in Interfaces.** The INSERT in `createEntry` gains `tx_network, tx_hash, tx_json`. Map the UNIQUE error to `DuplicateTxError`.

- [ ] **Step 5: Run `npx vitest run test/db.test.ts && npx tsc --noEmit`.** Expected: PASS, no type errors.

- [ ] **Step 6: Commit** `feat(db): entry tx columns, duplicate guard and tx_scans`

### Task 2: Chain lookups (`src/chain.ts`)

**Files:**
- Create: `src/chain.ts`, `test/chain.test.ts`

**Interfaces:**
- Produces:
  - `interface HashRef { hash: string; networks: Network[] }`. For `0x`-prefixed input: `{ hash: "0x…", networks: ["BSC"] }`. For bare 64-hex input: `{ hash: bare, networks: ["TRON", "BSC"] }`. When BSC is tried, the bare hash gets the `0x` prefix. All lowercase.
  - `findTxHash(text: string): HashRef | null` returns the first 64-hex run that is not part of a longer hex run (`(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])`). Text is normalized first with `normalize` from `money.ts`.
  - `interface UsdtTransfer { from: string; to: string; amount: Decimal }`
  - `interface TxInfo { network: Network; hash: string; succeeded: boolean; transfers: UsdtTransfer[]; confirmations: number; final: boolean; fee: Decimal; feeAsset: "TRX" | "BNB" }`. `transfers` holds only official-USDT transfers. BSC addresses are lowercase.
  - `type Lookup = { kind: "found"; tx: TxInfo } | { kind: "not_found" } | { kind: "error" }`
  - `lookupTron(hash: string, f: typeof fetch, apiKey?: string): Promise<Lookup>`
  - `lookupBsc(hash: string, f: typeof fetch, rpcUrl?: string): Promise<Lookup>`
  - `lookupTx(ref: HashRef, f: typeof fetch, env: Pick<Env, "TRONSCAN_API_KEY" | "BSC_RPC_URL">): Promise<Lookup>` tries `ref.networks` in order. It returns the first `found`. If none is found: `error` if any lookup errored, else `not_found`.
  - `explorerUrl(network, hash): string` returns `https://tronscan.org/#/transaction/<hash>` or `https://bscscan.com/tx/<hash>`.
  - `BSC_FINAL_CONFIRMATIONS = 15`
- Modify `env.d.ts`: add `TRONSCAN_API_KEY?: string; BSC_RPC_URL?: string;`.

- [ ] **Step 1: Write failing tests.** Use a local fake fetch that inspects the URL/body. `fakeFetch` in `test/fakes.ts` can't answer a JSON-RPC batch, so add `jsonRpcFetch(handler: (method: string, params: unknown[]) => unknown)` to `test/fakes.ts`.
  - `findTxHash`: the bare TRON hash from the fixture; the BSC `0x` hash; both inside the explorer links above; inside Persian text with ZWNJ; returns null for 63 or 65 hex chars and for plain text; uppercase input is lowercased.
  - `lookupTron` on `test/fixtures/tronscan-usdt-transfer.json`: found, `succeeded` true, one transfer from `TWTV2WWNBZ9crFQyv1mnoFTDi25YDrjsBZ` to `TFxi6L2JoLudi9Y22nRJ9xtTHTCGpkGfT4` with amount `1000`, `confirmations` 2, `final` false, `fee` equal to `6.7735` (6428500 + 345000 sun), `feeAsset` "TRX".
  - `lookupTron`: `{}` → not_found; HTTP 500 or throw → error; `contractRet: "REVERT"` → `succeeded` false; a transfer of another contract is dropped; `TRON-PRO-API-KEY` header is sent only when a key is given.
  - `lookupBsc` on `test/fixtures/bsc-usdt-receipt.json` with head block `0x7e9758f + 14` (so 15 confirmations): found, one transfer from `0xa010ec4e43c6448f2fe13340991bededf8763bf4` to `0x7c9e2d0cb5ec9ea82ddffd35bb4a1cb65d487809`. The amount is `0x542253a126ce40000` ÷ 1e18 = `97`; check this with Decimal in the test. `fee` = `0xc99f × 0x5f5e100` ÷ 1e18, `final` true. Head block +13 gives `final` false.
  - `lookupBsc`: `result: null` → not_found; `status: "0x0"` → `succeeded` false; a log from another contract or with another topic is ignored.
  - `lookupTx`: a bare hash, TRON not_found, BSC found → BSC result. TRON error and BSC not_found → error.

- [ ] **Step 2: Run `npx vitest run test/chain.test.ts`.** Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/chain.ts`.** Follow the `getJson` style in `prices.ts`: try/catch around everything, so a non-200 or bad JSON gives `error`.

- [ ] **Step 4: Run `npx vitest run test/chain.test.ts && npx tsc --noEmit`.** Expected: PASS.

- [ ] **Step 5: Commit** `feat: look up USDT transactions on Tronscan and BSC`

### Task 3: Scan logic (`src/txscan.ts`)

**Files:**
- Create: `src/txscan.ts`, `test/txscan.test.ts`

**Interfaces:**
- Consumes: `TxInfo`, `Network` (Task 2); `Entry`, `Leg` (`db.ts`, `ledger.ts`).
- Produces:
  - `parseWallet(network: Network, raw: string): string | null` returns the trimmed address (BSC lowercased), or null if invalid.
  - `type Classified = { kind: "ok"; side: "RECEIVE" | "PAY"; amount: Decimal; counterparty: string } | { kind: "refuse"; text: string }`
  - `classify(tx: TxInfo, wallet: string | null): Classified`. The checks run in this order: no wallet → refuse `NO_WALLET(network)`; not succeeded → `FAILED`; no USDT transfers → `NOT_USDT`. Then sum transfers with `to === wallet` (excluding self-transfers) as incoming, and `from === wallet` as outgoing. Both zero → `NOT_OURS`. Both nonzero → `AMBIGUOUS`. Otherwise RECEIVE (incoming) or PAY (outgoing). `counterparty` is the other side of the first matching transfer.
  - `dealFit(deal: Entry, side: "RECEIVE" | "PAY"): boolean` is true when the deal is not a payment, `asset === "USDT"`, and (BUY with RECEIVE) or (SELL with PAY).
  - `warnings(o: { final: boolean; network: Network; confirmations: number; amount: Decimal; deal: Entry | null; leg: Leg | null }): string[]` returns Persian lines. Not final → `NOT_FINAL` (with the count). Deal not approved → `DEAL_NOT_APPROVED`. Deal approved and `leg` null or `leg.remaining` 0 → `DEAL_SETTLED`. Leg open and |amount − remaining| ≥ 0.01 → `AMOUNT_MISMATCH` (shows both numbers).
  - Export the Persian text constants (`NO_WALLET`, `FAILED`, `NOT_USDT`, `NOT_OURS`, `AMBIGUOUS`, `NOT_FOUND`, `LOOKUP_ERROR`, `DUPLICATE`, `NOT_FINAL`, `DEAL_NOT_APPROVED`, `DEAL_SETTLED`, `AMOUNT_MISMATCH`, `DEAL_MISFIT`). The implementer writes the wording, following the tone of `message.ts`.

- [ ] **Step 1: Write failing tests** for every branch above. Include:
  - `parseWallet("BSC", "0x7C9E…")` returns lowercase.
  - `parseWallet("TRON", "TFxi6L2JoLudi9Y22nRJ9xtTHTCGpkGfT4")` returns the address unchanged; a 33-char address returns null.
  - `classify` with a mixed-case-saved BSC wallet works, because `parseWallet` lowercased it.
  - Two incoming transfers sum.
  - `warnings` with remaining `100` and amount `99.995` gives no mismatch; amount `99.99` gives a mismatch.

- [ ] **Step 2: Run `npx vitest run test/txscan.test.ts`.** Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run `npx vitest run test/txscan.test.ts && npx tsc --noEmit`.** Expected: PASS.

- [ ] **Step 5: Commit** `feat: classify scanned transfers and build their warnings`

### Task 4: Cards

**Files:**
- Modify: `src/cards.ts`
- Test: `test/cards.test.ts`

**Interfaces:**
- Consumes: `TxMeta` (Task 1), `explorerUrl` (Task 2), `Entry`, `Leg`.
- Produces:
  - `renderEntry` appends a tx block when `e.tx` is set: the network, the counterparty shortened (first 6 + `…` + last 4), confirmations (with ✅ final / ⏳), fee with `feeAsset`, `<a href="explorerUrl">` (escaped) on the shortened hash, the linked deal code when `e.linkedDealId` is set, and each `e.tx.warnings` line prefixed `⚠️ `.
  - `renderTxScan(s: TxScan, note?: string): string` is the picker message: direction, amount, the same tx block, an optional `note` line (the `DEAL_MISFIT` reason), and the prompt "which deal?".
  - `txPickerKeyboard(scanId: number, deals: { id: number; code: string; remaining: Decimal }[]): Keyboard` has one button per deal (`<code> · <remaining> USDT`, callback `tp:<scanId>:<dealId>`) and a last button "بدون معامله" (`tp:<scanId>:0`). At most 8 deals, oldest first.

- [ ] **Step 1: Write failing tests.** A RECEIVE entry with tx contains `tronscan.org/#/transaction/`, the short counterparty, the fee `6.7735`, and the warning text. `<` in a warning is escaped. The keyboard has 8 deal rows + 1 when given 10 deals, and `callback_data` is ≤ 64 bytes.

- [ ] **Step 2: Run `npx vitest run test/cards.test.ts`.** Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run `npx vitest run test/cards.test.ts && npx tsc --noEmit`.** Expected: PASS.

- [ ] **Step 5: Commit** `feat: show transaction details on payment cards`

### Task 5: Message flow, routing and picker callback

**Files:**
- Create: `src/handlers/txscan.ts`, `test/txscan-flow.test.ts`
- Modify: `src/handlers/update.ts`, `src/handlers/callback.ts`, `src/handlers/message.ts` (export `send`, `sendCard`, `who`; widen `sendCard`'s first parameter to `Pick<Ctx, "app" | "msg" | "chatId">`)

**Interfaces:**
- Consumes: everything above; `approvedLedger`, `allocate`, `openDeals`, `findByCardMessage`, `getSetting`, `setCardMessage`.
- Produces:
  - `txScanTarget(msg: Message, bot: { id: number; username: string }, fromAdmin: boolean): { ref: HashRef; dealMsgId: number | null } | null`
    - If `msg.text` starts with `#` or `/` → null.
    - If `findTxHash(msg.text)` finds a hash → that hash. `dealMsgId` is `msg.reply_to_message.message_id` when the replied-to message is from the bot, else null.
    - Else if `fromAdmin`, the message tags the bot (reuse `isAddressed` mention detection), and `msg.reply_to_message.text` contains a hash → that hash, with `dealMsgId` null.
    - Else null.
  - `handleTxScan(app: App, msg: Message, target): Promise<void>` runs these steps:
    1. Private chat → `PRIVATE_WRITE`-style refusal. (In practice update.ts only calls it for groups.)
    2. Read `wallet_tron`/`wallet_bsc`.
    3. `lookupTx`. not_found → `NOT_FOUND`. error → `LOOKUP_ERROR`.
    4. `classify` with the wallet for `tx.network`. refuse → send its text.
    5. `findActiveByTx` → `DUPLICATE`, plus `<code>` of the entry if it's in the same chat.
    6. Resolve the deal: `dealMsgId` → `findByCardMessage`. Found and `dealFit` → linked. Found and not fitting → picker with `DEAL_MISFIT` note. None → picker.
    7. Linked: get the leg from `allocate(approvedLedger)` (USDT leg in the matching direction). Build `TxMeta` with `warnings(...)`. `createEntry` with `side`, `amount`, `asset: "USDT"`, `note` = short hash, `linkedDealId`, `tx`, `sourceMsgId`, `createdBy: who(msg.from)`. Then `sendCard` with `renderEntry` + `entryKeyboard`, and `setCardMessage`. `DuplicateTxError` → `DUPLICATE`.
    8. Picker: `openDeals(approvedLedger)` filtered to deals with an open USDT leg in the matching direction. `createTxScan`. Send `renderTxScan` + `txPickerKeyboard` as a reply.
    - Clients and admins both reach steps 1–8.
  - `handleTxPick(app: App, q: CallbackQuery, scanId: number, dealId: number): Promise<void>`. callback.ts calls it only after the existing admin check passes, so clients get `NOT_ALLOWED`. The steps:
    1. `takeTxScan` (null → `ALREADY`). The scan's chat must equal the message chat.
    2. `dealId` 0 → no deal. Otherwise `getEntry`, which must be in the same chat and `dealFit`; if not, release the scan and answer `NOT_FOUND`.
    3. Compute warnings and `createEntry`. `DuplicateTxError` → edit the message to `DUPLICATE`, keep the scan used, answer.
    4. Edit the picker message into `renderEntry` + `entryKeyboard`, then `setCardMessage(entry.id, msgId)`.
    5. Any other failure → `releaseTxScan` and rethrow.
- In `update.ts`, after the `activated` check and before the `/` and `isAddressed` handling, for group messages: `const t = txScanTarget(msg, await botInfo(app), fromAdmin); if (t) return handleTxScan(app, msg, t);`.
- In `callback.ts`, before the existing regex: `/^tp:(\d+):(\d+)$/` → `handleTxPick` (after the admin check).

- [ ] **Step 1: Write failing tests in `test/txscan-flow.test.ts`.** Use `makeApp` with a fake fetch serving the fixtures, and wallets set via `setSetting`. Seed an approved BUY USDT deal (and its card message id) with `createEntry` + `transition` + `setCardMessage`, following the style of `test/message.test.ts`.
  - `client replies to deal card with TRON hash → pending RECEIVE linked to deal`: amount `1000`, `tx.network` "TRON", the card has the not-final warning (2 confirmations), and the status is pending (not approved).
  - `untagged bare hash in activated group → picker listing open deals`: the keyboard has the deal + "بدون معامله", and no entry is created.
  - `admin presses picker deal → card created and picker message edited`; a second press → `ALREADY`, still one entry.
  - `client presses picker → NOT_ALLOWED, no entry`.
  - `outgoing BSC transfer from our wallet → PAY` with a SELL deal in the picker. The wallet is saved in mixed case.
  - `amount mismatch warning` when the deal remaining ≠ amount; no warning when equal.
  - `duplicate hash → DUPLICATE` in the same group (shows the code) and in another group (no code). The race: the second `createEntry` throws `DuplicateTxError` → `DUPLICATE`.
  - `not found → NOT_FOUND, nothing stored; posting again after the fixture is served → works`.
  - `lookup error / no wallet / not ours / failed tx → the matching refusal, nothing stored`.
  - `reply to a payment card or a non-USDT deal → picker with DEAL_MISFIT note`.
  - `admin tags bot replying to a client's hash message → scans the replied hash`.
  - `# message containing a hash → goes to the legacy parser, not the scan`.
  - `non-activated group or private chat stranger → silent` (no fetch calls: fake fetch throws if called).
  - `scan path makes no Gemini call` (`FakeNlu.inputs` is empty).

- [ ] **Step 2: Run `npx vitest run test/txscan-flow.test.ts`.** Expected: FAIL.

- [ ] **Step 3: Implement `src/handlers/txscan.ts` and the routing and callback hooks.**

- [ ] **Step 4: Run `npm test && npx tsc --noEmit`.** Expected: all tests PASS (existing `update`, `message` and `callback` tests unchanged).

- [ ] **Step 5: Commit** `feat: scan posted transaction hashes into payment cards`

### Task 6: Mini App wallet settings and docs

**Files:**
- Modify: `src/miniapp/api.ts`, `public/app/app.js`, `test/miniapp.test.ts`, `.dev.vars.example`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `parseWallet` (Task 3).
- Produces: `GET /api/settings` gains `wallet_tron: string | null` and `wallet_bsc: string | null`. `PATCH` accepts them. A string is validated with `parseWallet`; invalid → `bad("آدرس کیف پول … معتبر نیست.")`. An empty string deletes the setting, which needs a new `deleteSetting(db, key)` in db.ts (or storing `""` and treating it as unset; pick one).

- [ ] **Step 1: Write failing tests in `test/miniapp.test.ts`:**
  - PATCH a valid TRON and a mixed-case BSC wallet → GET returns the TRON address and the BSC address lowercased.
  - An invalid wallet → 400.
  - An empty string → null.
  - A non-admin → 403 (follow the existing settings tests).

- [ ] **Step 2: Run `npx vitest run test/miniapp.test.ts`.** Expected: FAIL.

- [ ] **Step 3: Implement the API change.** Then add a "کیف پول‌ها" card to `showSettings` in `public/app/app.js` with two inputs (TRON, BSC) and one save button that PATCHes both.

- [ ] **Step 4: Docs:**
  - `.dev.vars.example` gets `TRONSCAN_API_KEY=` (optional).
  - README gets a short user-guide section "اسکن هش تراکنش" (the three ways, warnings, wallets in the Mini App) and the optional secret / `BSC_RPC_URL` var in deployment.
  - In CLAUDE.md's **Permissions** rule, add: "Exception: a client's transaction hash may create a *pending* scan card; clients still cannot approve it or press the deal-picker buttons." Add `chain.ts`/`txscan.ts` to the module list.

- [ ] **Step 5: Run `npm test && npx tsc --noEmit`.** Expected: PASS.

- [ ] **Step 6: Commit** `feat(miniapp): wallet settings for transaction scan; docs`

---

## Plan-level decisions (deviations from the spec)

- **Path 2's nested reply.** Telegram doesn't include the replied-to message's own `reply_to_message`. So when an admin tags the bot on a client's hash, the bot can't see whether that client message replied to a deal card, and it always goes to the picker. In practice the client's message was already scanned when it arrived, because untagged hashes are auto-scanned. A deal-card reply would already have created its card, so the admin's tag then gets `DUPLICATE`.
- **A transaction both into and out of our wallet** is refused (`AMBIGUOUS`). The spec didn't cover it.
