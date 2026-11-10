import type { CallbackQuery, Message, Update } from "@grammyjs/types";
import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createEntry, type Entry, findActiveByTx, listEntries, setCardMessage, setSetting, transition,
  upsertAccount,
} from "../src/db";
import { handleCallback } from "../src/handlers/callback";
import { handleUpdate } from "../src/handlers/update";
import type { Trade } from "../src/trade";
import { DEAL_MISFIT, DUPLICATE, FAILED, LOOKUP_ERROR, NO_WALLET, NOT_FOUND, NOT_OURS } from "../src/txscan";
import tronFixture from "./fixtures/tronscan-usdt-transfer.json";
import bscFixture from "./fixtures/bsc-usdt-receipt.json";
import { jsonRpcFetch, makeApp, type TestApp } from "./fakes";

const db = env.DB;
const D = (s: string | number) => new Decimal(s);
const AT = "2026-11-08T10:00:00+03:30";
const BOT = { id: 99, username: "acc_bot" };
const ADMIN = { id: 1, is_bot: false, first_name: "Admin" };
const CLIENT = { id: 5, is_bot: false, first_name: "Client" };
const OUR_TRON = "TFxi6L2JoLudi9Y22nRJ9xtTHTCGpkGfT4"; // the fixture's receiver
const OUR_BSC_MIXED = "0xA010EC4e43c6448f2FE13340991bEdedF8763bF4"; // the BSC fixture's sender
const BSC_BLOCK = 0x7e9758f;
const hex = (n: number) => `0x${n.toString(16)}`;

let seq = 0;
let nextChat = 9000;
let uid = 50_000;
const tronHash = () => `${"e".repeat(56)}${(++seq).toString(16).padStart(8, "0")}`;
const bscHash = () => `0x${"b".repeat(56)}${(++seq).toString(16).padStart(8, "0")}`;

interface Chain {
  tron?: Record<string, unknown> | number | "missing";
  bscReceipt?: unknown;
  head?: number;
}
const nlu: { calls: number } = { calls: 0 };

/** Tronscan and BSC RPC fakes; any other host (Nobitex, Gemini) is an error, so the scan path must not call it. */
function chainFetch(o: Chain, log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    log.push(url);
    if (url.includes("apilist.tronscanapi.com")) {
      if (typeof o.tron === "number") return new Response(null, { status: o.tron });
      const hash = new URL(url).searchParams.get("hash");
      const body = o.tron === undefined || o.tron === "missing" ? {} : { ...o.tron, hash };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.includes("bsc-dataseed")) {
      return jsonRpcFetch((m) => (m === "eth_getTransactionReceipt" ? (o.bscReceipt ?? null) : hex(o.head ?? BSC_BLOCK + 30)))(input, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

const appWith = (o: Chain, log?: string[]): TestApp => makeApp({ fetch: chainFetch(o, log) });

async function group(activated = true): Promise<number> {
  const chatId = -(++nextChat * 13);
  await upsertAccount(db, { chatId, title: "G", type: "supergroup", at: AT, activated });
  return chatId;
}

const trade = (over: Partial<Trade> = {}): Trade => ({
  side: "BUY", amount: D(1000), asset: "USDT", rate: D(266000), note: "", tomanTotal: null, ...over,
});

/** An approved deal with a card message id. */
async function deal(chatId: number, over: Partial<Trade> = {}, cardMsgId = 500 + seq): Promise<Entry> {
  const e = await createEntry(db, { chatId, trade: trade(over), createdBy: "a", createdById: 1, createdAt: AT });
  await transition(db, [e.id], "pending", "approved");
  await setCardMessage(db, e.id, cardMsgId);
  return { ...e, status: "approved", cardMsgId };
}

function msg(chatId: number, text: string, over: Record<string, unknown> = {}): Message {
  return { message_id: ++uid, date: 0, chat: { id: chatId, type: "supergroup", title: "G" }, from: CLIENT, text, ...over } as unknown as Message;
}
const replyToBot = (messageId: number) => ({
  message_id: messageId, date: 0, chat: { id: 0, type: "supergroup" }, from: { id: BOT.id, is_bot: true, first_name: "B" },
});
const upd = (m: Message): Update => ({ update_id: ++uid, message: m as Update["message"] });
const sent = (app: TestApp) => app.tg.calls.filter((c) => c.method === "sendMessage").map((c) => c.params);
const lastText = (app: TestApp) => String(sent(app).at(-1)?.text ?? "");
const entriesOf = (chatId: number) => listEntries(db, { chatId, limit: 50 } as never);

const cb = (chatId: number, data: string, userId: number, msgId: number): CallbackQuery =>
  ({
    id: "q", from: { id: userId, is_bot: false, first_name: "X" }, chat_instance: "x", data,
    message: { message_id: msgId, chat: { id: chatId, type: "supergroup", title: "G" }, date: 0 },
  }) as unknown as CallbackQuery;

beforeEach(async () => {
  vi.restoreAllMocks();
  nlu.calls = 0;
  await setSetting(db, "bot_id", String(BOT.id));
  await setSetting(db, "bot_username", BOT.username);
  await setSetting(db, "wallet_tron", OUR_TRON);
  await setSetting(db, "wallet_bsc", OUR_BSC_MIXED.toLowerCase());
});

describe("scan from a reply to a deal card", () => {
  test("client replies to deal card with TRON hash → pending RECEIVE linked to deal", async () => {
    const chat = await group();
    const d = await deal(chat);
    const app = appWith({ tron: tronFixture });
    const h = tronHash();
    await handleUpdate(app, upd(msg(chat, h, { reply_to_message: replyToBot(d.cardMsgId!) })));
    const e = await findActiveByTx(db, "TRON", h);
    expect(e).not.toBeNull();
    expect(e!.status).toBe("pending");
    expect(e!.trade.side).toBe("RECEIVE");
    expect(e!.trade.asset).toBe("USDT");
    expect(e!.trade.amount.eq(1000)).toBe(true);
    expect(e!.linkedDealId).toBe(d.id);
    expect(e!.tx?.confirmations).toBe(2);
    expect(e!.tx?.warnings.length).toBe(1); // not final; amount equals what's left
    expect(e!.cardMsgId).not.toBeNull();
    expect(lastText(app)).toContain("tronscan.org");
    expect(app.nlu.inputs).toHaveLength(0);
  });

  test("amount mismatch warning when what's left differs", async () => {
    const chat = await group();
    const d = await deal(chat, { amount: D(1500) });
    const h = tronHash();
    await handleUpdate(appWith({ tron: { ...tronFixture, confirmed: true } }), upd(msg(chat, h, { reply_to_message: replyToBot(d.cardMsgId!) })));
    const e = await findActiveByTx(db, "TRON", h);
    expect(e!.tx!.warnings).toHaveLength(1);
    expect(e!.tx!.warnings[0]).toContain("برابر نیست");
  });

  test("reply to a payment card → picker with the misfit note", async () => {
    const chat = await group();
    const p = await deal(chat, { side: "RECEIVE", rate: null });
    const app = appWith({ tron: tronFixture });
    const h = tronHash();
    await handleUpdate(app, upd(msg(chat, h, { reply_to_message: replyToBot(p.cardMsgId!) })));
    expect(await findActiveByTx(db, "TRON", h)).toBeNull();
    expect(lastText(app)).toContain(DEAL_MISFIT.slice(0, 20));
    expect(JSON.stringify(sent(app).at(-1)?.reply_markup)).toContain("tp:");
  });
});

describe("picker", () => {
  test("untagged bare hash → picker listing open deals; no entry yet", async () => {
    const chat = await group();
    const d = await deal(chat);
    await deal(chat, { side: "SELL" }); // wrong direction: not offered
    const app = appWith({ tron: tronFixture });
    const h = tronHash();
    await handleUpdate(app, upd(msg(chat, `واریز شد ${h}`)));
    expect(await findActiveByTx(db, "TRON", h)).toBeNull();
    const kb = (sent(app).at(-1)?.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(kb).toHaveLength(2);
    expect(kb[0][0].callback_data).toMatch(new RegExp(`^tp:\\d+:${d.id}$`));
    expect(kb[1][0].callback_data).toMatch(/^tp:\d+:0$/);
  });

  async function picker(chat: number, app: TestApp, h: string) {
    await handleUpdate(app, upd(msg(chat, h)));
    const s = sent(app).at(-1)!;
    const kb = (s.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const msgId = app.tg.calls.filter((c) => c.method === "sendMessage").length; // FakeTg ids start at 1, one per call
    return { kb, msgId };
  }

  test("admin presses a deal → card created and picker message edited; second press → already", async () => {
    const chat = await group();
    const d = await deal(chat);
    const app = appWith({ tron: tronFixture });
    const h = tronHash();
    const { kb, msgId } = await picker(chat, app, h);
    await handleCallback(app, cb(chat, kb[0][0].callback_data, ADMIN.id, msgId));
    const e = await findActiveByTx(db, "TRON", h);
    expect(e?.linkedDealId).toBe(d.id);
    expect(e?.cardMsgId).toBe(msgId);
    const edit = app.tg.calls.filter((c) => c.method === "editMessageText").at(-1)!.params;
    expect(edit.message_id).toBe(msgId);
    expect(JSON.stringify(edit.reply_markup)).toContain(`ok:${e!.id}`);
    await handleCallback(app, cb(chat, kb[0][0].callback_data, ADMIN.id, msgId));
    expect((await entriesOf(chat)).filter((x) => x.tx).length).toBe(1);
    const ans = app.tg.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)!.params;
    expect(ans.show_alert).toBe(true);
  });

  test("no-deal button creates an unlinked card", async () => {
    const chat = await group();
    const app = appWith({ tron: tronFixture });
    const h = tronHash();
    const { kb, msgId } = await picker(chat, app, h);
    await handleCallback(app, cb(chat, kb.at(-1)![0].callback_data, ADMIN.id, msgId));
    const e = await findActiveByTx(db, "TRON", h);
    expect(e?.linkedDealId).toBeNull();
    expect(e?.status).toBe("pending");
  });

  test("client presses picker → not allowed, no entry", async () => {
    const chat = await group();
    const app = appWith({ tron: tronFixture });
    const h = tronHash();
    const { kb, msgId } = await picker(chat, app, h);
    await handleCallback(app, cb(chat, kb.at(-1)![0].callback_data, CLIENT.id, msgId));
    expect(await findActiveByTx(db, "TRON", h)).toBeNull();
  });

  test("picker pressed after the hash got a card another way → duplicate", async () => {
    const chat = await group();
    const d = await deal(chat);
    const app = appWith({ tron: tronFixture });
    const h = tronHash();
    const { kb, msgId } = await picker(chat, app, h);
    await handleUpdate(app, upd(msg(chat, h, { reply_to_message: replyToBot(d.cardMsgId!) })));
    await handleCallback(app, cb(chat, kb.at(-1)![0].callback_data, ADMIN.id, msgId));
    expect((await entriesOf(chat)).filter((x) => x.tx).length).toBe(1);
    const edit = app.tg.calls.filter((c) => c.method === "editMessageText").at(-1)!.params;
    expect(String(edit.text)).toContain(DUPLICATE(null).slice(0, 15));
  });

  test("outgoing BSC transfer from our (mixed-case saved) wallet → PAY, SELL deal offered", async () => {
    await setSetting(db, "wallet_bsc", OUR_BSC_MIXED.toLowerCase());
    const chat = await group();
    const sell = await deal(chat, { side: "SELL", amount: D(97) });
    const app = appWith({ bscReceipt: bscFixture.result });
    const h = bscHash();
    const { kb, msgId } = await picker(chat, app, h);
    expect(kb[0][0].callback_data).toMatch(new RegExp(`:${sell.id}$`));
    await handleCallback(app, cb(chat, kb[0][0].callback_data, ADMIN.id, msgId));
    const e = await findActiveByTx(db, "BSC", h);
    expect(e?.trade.side).toBe("PAY");
    expect(e?.trade.amount.eq(97)).toBe(true);
    expect(e?.tx?.feeAsset).toBe("BNB");
    expect(e?.tx?.warnings).toEqual([]);
  });

  test("admin tags bot replying to a client's hash message → scans the replied hash", async () => {
    const chat = await group();
    const app = appWith({ tron: tronFixture });
    const h = tronHash();
    const clientMsg = msg(chat, h);
    const m = msg(chat, "@acc_bot این رو چک کن", {
      from: ADMIN, entities: [{ type: "mention", offset: 0, length: 8 }], reply_to_message: clientMsg,
    });
    await handleUpdate(app, upd(m));
    expect(lastText(app)).toContain("کدام معامله");
  });
});

describe("refusals", () => {
  test("duplicate in the same group shows the code; in another group it doesn't", async () => {
    const chat = await group();
    const d = await deal(chat);
    const h = tronHash();
    const app = appWith({ tron: tronFixture });
    await handleUpdate(app, upd(msg(chat, h, { reply_to_message: replyToBot(d.cardMsgId!) })));
    const e = (await findActiveByTx(db, "TRON", h))!;
    await handleUpdate(app, upd(msg(chat, h)));
    expect(lastText(app)).toBe(DUPLICATE(e.code));
    const other = await group();
    await handleUpdate(app, upd(msg(other, h)));
    expect(lastText(app)).toBe(DUPLICATE(null));
  });

  test("race: insert hits the unique index → duplicate refusal", async () => {
    const chat = await group();
    const d = await deal(chat);
    const h = tronHash();
    // Another webhook already stored this hash, but our duplicate pre-check ran before it committed.
    await createEntry(db, {
      chatId: chat, trade: trade({ side: "RECEIVE", rate: null }), createdBy: "x", createdById: 2, createdAt: AT,
      tx: { network: "TRON", hash: h, counterparty: "T", confirmations: 1, final: false, fee: D(0), feeAsset: "TRX", warnings: [] },
    });
    const blind = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
        return (sql: string) =>
          /tx_network = \? AND tx_hash = \?/.test(sql)
            ? { bind: () => ({ first: async () => null }) }
            : target.prepare(sql);
      },
    });
    const app = makeApp({ fetch: chainFetch({ tron: tronFixture }), db: blind as D1Database });
    await handleUpdate(app, upd(msg(chat, h, { reply_to_message: replyToBot(d.cardMsgId!) })));
    expect(lastText(app)).toBe(DUPLICATE(null));
    expect((await entriesOf(chat)).filter((x) => x.tx).length).toBe(1);
  });

  test("not found → NOT_FOUND and nothing stored; later it works", async () => {
    const chat = await group();
    const h = tronHash();
    const missing = appWith({ tron: "missing", bscReceipt: null });
    await handleUpdate(missing, upd(msg(chat, h)));
    expect(lastText(missing)).toBe(NOT_FOUND);
    const later = appWith({ tron: tronFixture });
    await handleUpdate(later, upd(msg(chat, h)));
    expect(lastText(later)).toContain("کدام معامله");
  });

  test("lookup error, no wallet, not ours, failed", async () => {
    const chat = await group();
    const err = appWith({ tron: 500, bscReceipt: null });
    await handleUpdate(err, upd(msg(chat, tronHash())));
    expect(lastText(err)).toBe(LOOKUP_ERROR);

    const failed = appWith({ tron: { ...tronFixture, contractRet: "REVERT" } });
    await handleUpdate(failed, upd(msg(chat, tronHash())));
    expect(lastText(failed)).toBe(FAILED);

    await setSetting(db, "wallet_tron", "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj");
    const notOurs = appWith({ tron: tronFixture });
    await handleUpdate(notOurs, upd(msg(chat, tronHash())));
    expect(lastText(notOurs)).toBe(NOT_OURS);

    await db.prepare("DELETE FROM settings WHERE key = 'wallet_tron'").run();
    const noWallet = appWith({ tron: tronFixture });
    await handleUpdate(noWallet, upd(msg(chat, tronHash())));
    expect(lastText(noWallet)).toBe(NO_WALLET("TRON"));
    expect((await entriesOf(chat)).length).toBe(0);
  });
});

describe("routing", () => {
  test("# message containing a hash goes to the legacy parser, not the scan", async () => {
    const chat = await group();
    const log: string[] = [];
    const app = appWith({ tron: tronFixture }, log);
    await handleUpdate(app, upd(msg(chat, `#دریافت ۱۰ تتر ${tronHash()}`, { from: ADMIN })));
    expect(log.some((u) => u.includes("tronscanapi"))).toBe(false);
  });

  test("non-activated group and a private-chat stranger → silent, no lookups", async () => {
    const log: string[] = [];
    const app = appWith({ tron: tronFixture }, log);
    const quiet = await group(false);
    await handleUpdate(app, upd(msg(quiet, tronHash())));
    await handleUpdate(app, upd(msg(5, tronHash(), { chat: { id: 5, type: "private", first_name: "C" } })));
    expect(log).toEqual([]);
    expect(sent(app)).toEqual([]);
  });
});
