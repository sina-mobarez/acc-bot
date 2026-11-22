import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import type { Message } from "@grammyjs/types";
import { beforeAll, describe, expect, onTestFinished, test } from "vitest";
import { bankKey, matchBank, splitBankNote } from "../src/banks";
import {
  type Bank, bankBalances, setSetting, cancelEntry, createBank, createEntry, getEntry, listBankMoves, listBanks, recent, transition,
  upsertAccount,
} from "../src/db";
import { handleCommand } from "../src/handlers/commands";
import { handleMessage } from "../src/handlers/message";
import { toAction } from "../src/intent";
import { handleApi } from "../src/miniapp/api";
import type { NluOutput } from "../src/nlu";
import { FakeNlu, fakeFetch, FIXED_NOW, makeApp, type TestApp } from "./fakes";

const db = env.DB;
const D = (s: string | number) => new Decimal(s);
const ADMIN = { id: 1, is_bot: false, first_name: "Sina", username: "sina" };
const CLIENT = { id: 7, is_bot: false, first_name: "Ali" };
const NOBITEX = { status: "ok", stats: { "usdt-rls": { latest: "2660000", bestBuy: "2659000", bestSell: "2661000" } } };

let nextChat = 7000;
const group = () => ({ id: -(++nextChat), type: "supergroup" as const, title: `G${nextChat}` });
const PRIVATE = { id: 1, type: "private" as const, first_name: "Sina" };
let nextMsg = 500;
const msg = (chat: object, from: object, text: string): Message =>
  ({ message_id: ++nextMsg, date: 0, chat, from, text }) as unknown as Message;
const app = (...script: (NluOutput | null)[]): TestApp =>
  makeApp({ nlu: new FakeNlu(...script), fetch: fakeFetch({ "apiv2.nobitex.ir": NOBITEX }) });
const texts = (a: TestApp) => a.tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text));
const balanceOf = async (b: Bank) => ((await bankBalances(db)).get(b.id) ?? D(0)).toFixed();

let saman: Bank;
let gardesh: Bank;
beforeAll(async () => {
  saman = await createBank(db, "سامان", FIXED_NOW);
  gardesh = await createBank(db, "گردشگری", FIXED_NOW);
});

describe("matching a bank name", () => {
  const banks = [{ id: 1, name: "سامان" }, { id: 2, name: "گردشگری" }, { id: 3, name: "سامان شرکت" }];

  test("ignores «بانک», «حساب», spacing and Arabic letters", () => {
    expect(bankKey("بانک  سامان")).toBe(bankKey("سامان"));
    expect(matchBank(banks, "حساب گردشگري")?.id).toBe(2);
    expect(matchBank(banks, "بانک سامان")?.id).toBe(1); // exact beats the longer «سامان شرکت»
    expect(matchBank(banks, "سامان شرکت")?.id).toBe(3);
  });

  test("an unknown or ambiguous name matches nothing", () => {
    expect(matchBank(banks, "ملت")).toBeNull();
    expect(matchBank(banks, "بانک")).toBeNull();
    expect(matchBank([{ id: 1, name: "سامان شرکت" }, { id: 2, name: "سامان شخصی" }], "سامان")).toBeNull();
  });

  test("a # note that starts with a bank gives the bank and the rest", () => {
    expect(splitBankNote(banks, "به حساب سامان بابت فاکتور")).toEqual({ bank: banks[0], note: "بابت فاکتور" });
    expect(splitBankNote(banks, "سامان شرکت")).toEqual({ bank: banks[2], note: "" });
    expect(splitBankNote(banks, "کارت به کارت")).toBeNull();
    expect(splitBankNote(banks, "")).toBeNull();
  });
});

describe("client payments on a bank (group)", () => {
  test("a received toman payment raises the bank only once approved; cancelling takes it back", async () => {
    const chat = group();
    const before = D(await balanceOf(saman));
    const a = app({ intent: "record_payment", direction: "RECEIVE", amount_text: "۵۰ میلیون", bank: "بانک سامان", ref: "۱۱۲۲۳۳" });
    await handleMessage(a, msg(chat, ADMIN, "۵۰ میلیون تومن دریافت شد به سامان"), "۵۰ میلیون تومن دریافت شد به سامان");
    const [e] = await recent(db, chat.id, 1);
    expect(e.bank).toEqual({ id: saman.id, name: "سامان" });
    expect(texts(a).at(-1)).toContain("🏦 <b>بانک:</b> سامان");
    expect(await balanceOf(saman)).toBe(before.toFixed()); // pending: nothing yet

    await transition(db, [e.id], "pending", "approved", { decidedBy: "@sina", decidedAt: FIXED_NOW });
    expect(await balanceOf(saman)).toBe(before.plus(50_000_000).toFixed());

    await cancelEntry(db, e.id, "approved", "@sina", FIXED_NOW);
    expect(await balanceOf(saman)).toBe(before.toFixed());
  });

  test("a payment to the client lowers the bank; the # grammar reads the bank from the note", async () => {
    const chat = group();
    const before = D(await balanceOf(gardesh));
    const a = app();
    await handleMessage(a, msg(chat, ADMIN, "#پرداخت ۲۰ میلیون تومن گردشگری بابت تسویه پیگیری 5566"), "#پرداخت ۲۰ میلیون تومن گردشگری بابت تسویه پیگیری 5566");
    const [e] = await recent(db, chat.id, 1);
    expect(e.bank?.id).toBe(gardesh.id);
    expect(e.trade.note).toBe("بابت تسویه");
    await transition(db, [e.id], "pending", "approved");
    expect(await balanceOf(gardesh)).toBe(before.minus(20_000_000).toFixed());
  });

  test("a bank we don't have is asked about, not recorded without it", async () => {
    const chat = group();
    const a = app({ intent: "record_payment", direction: "RECEIVE", amount_text: "۵ میلیون", bank: "<ملت>" });
    await handleMessage(a, msg(chat, ADMIN, "x"), "x");
    expect(await recent(db, chat.id, 1)).toEqual([]);
    expect(texts(a).at(-1)).toContain("بانک «&lt;ملت&gt;» را نمی‌شناسم");
    expect(texts(a).at(-1)).toContain("سامان");
  });

  test("a USDT payment never gets a bank", async () => {
    const chat = group();
    const a = app({ intent: "record_payment", direction: "RECEIVE", amount_text: "۱۰۰", asset: "تتر", bank: "سامان", ref: "abcdef12" });
    await handleMessage(a, msg(chat, ADMIN, "x"), "x");
    expect((await recent(db, chat.id, 1))[0].bank).toBeNull();
  });

  test("«تسویه کن به سامان» puts the toman leg on the bank", async () => {
    const chat = group();
    const deal = await createEntry(db, {
      chatId: chat.id, createdBy: "@sina", createdById: 1, createdAt: FIXED_NOW,
      trade: { side: "SELL", amount: D(100), asset: "USDT", rate: D(270000), note: "", tomanTotal: null },
    });
    await transition(db, [deal.id], "pending", "approved");
    const a = app({ intent: "settle_deal", deal_code: deal.code, bank: "سامان" });
    await handleMessage(a, msg(chat, ADMIN, "x"), "x");
    const legs = (await recent(db, chat.id, 5)).filter((e) => e.linkedDealId === deal.id);
    expect(legs.map((e) => [e.trade.asset, e.bank?.name ?? null]).sort()).toEqual([["IRT", "سامان"], ["USDT", null]]);
    expect(texts(a).at(-1)).toContain("🏦 سامان");
  });

  test("the balance is never shown in a group, and a client can't ask for it at all", async () => {
    const chat = group();
    await upsertAccount(db, { chatId: chat.id, title: chat.title, type: "supergroup", at: FIXED_NOW, activated: true });
    const a = app({ intent: "query_banks" });
    await handleMessage(a, msg(chat, ADMIN, "موجودی بانک‌ها"), "موجودی بانک‌ها");
    expect(texts(a).at(-1)).toContain("فقط در چت خصوصی");
    expect(texts(a).at(-1)).not.toContain("سامان");

    await handleCommand(a, msg(chat, ADMIN, "/banks"));
    expect(texts(a)).toHaveLength(1); // silent

    expect(toAction({ intent: "query_banks" }, { role: "client", usdtToman: null, defaultAsset: "USDT" }).kind).toBe("reply");
    const c = app({ intent: "chitchat", reply: "سلام" });
    await handleMessage(c, msg(chat, CLIENT, "سلام"), "سلام");
    expect(c.nlu.inputs[0].bankNames).toBeUndefined(); // bank names don't reach a client's NLU call
  });
});

describe("private chat", () => {
  test("deposit and withdrawal move the bank at once and report the balance", async () => {
    const before = D(await balanceOf(saman));
    const a = app(
      { intent: "record_payment", direction: "RECEIVE", amount_text: "۳۰ میلیون", bank: "سامان", note: "موجودی اولیه" },
      { intent: "record_payment", direction: "PAY", amount_text: "۱۰ میلیون", bank: "سامان" },
    );
    await handleMessage(a, msg(PRIVATE, ADMIN, "واریز ۳۰ میلیون به سامان"), "واریز ۳۰ میلیون به سامان");
    expect(await balanceOf(saman)).toBe(before.plus(30_000_000).toFixed());
    expect(texts(a).at(-1)).toContain("واریز ۳۰,۰۰۰,۰۰۰ تومان");
    await handleMessage(a, msg(PRIVATE, ADMIN, "برداشت ۱۰ میلیون از سامان"), "برداشت ۱۰ میلیون از سامان");
    expect(await balanceOf(saman)).toBe(before.plus(20_000_000).toFixed());
    expect(texts(a).at(-1)).toContain("برداشت ۱۰,۰۰۰,۰۰۰ تومان");
    // The bot's question (require_ref on) keeps the bank.
    await setSetting(db, "require_ref", "1");
    onTestFinished(() => setSetting(db, "require_ref", "0"));
    const g = group();
    const q = app({ intent: "record_payment", direction: "RECEIVE", amount_text: "۱ میلیون", bank: "سامان" });
    await handleMessage(q, msg(g, ADMIN, "x"), "x");
    expect(texts(q).at(-1)).toContain("🏦 سامان");
    expect(await recent(db, g.id, 1)).toEqual([]);
    const [last, first] = await listBankMoves(db, saman.id, 2);
    expect([first.amount.toFixed(), first.note, last.amount.toFixed()]).toEqual(["30000000", "موجودی اولیه", "-10000000"]);
  });

  test("the # grammar works too; without a bank it asks which one", async () => {
    const before = D(await balanceOf(gardesh));
    const a = app();
    await handleMessage(a, msg(PRIVATE, ADMIN, "#دریافت ۵ میلیون گردشگری"), "#دریافت ۵ میلیون گردشگری");
    expect(await balanceOf(gardesh)).toBe(before.plus(5_000_000).toFixed());
    await handleMessage(a, msg(PRIVATE, ADMIN, "#دریافت ۵ میلیون"), "#دریافت ۵ میلیون");
    expect(texts(a).at(-1)).toContain("کدام بانک؟");
    expect(await balanceOf(gardesh)).toBe(before.plus(5_000_000).toFixed());
  });

  test("asking for the balance and /banks list every bank", async () => {
    const a = app({ intent: "query_banks" });
    await handleMessage(a, msg(PRIVATE, ADMIN, "موجودی بانک‌ها"), "موجودی بانک‌ها");
    expect(texts(a).at(-1)).toContain("موجودی بانک‌ها");
    expect(texts(a).at(-1)).toContain("گردشگری");
    await handleCommand(a, msg(PRIVATE, ADMIN, "/banks"));
    expect(texts(a).at(-1)).toContain("سامان");
    const stranger = app();
    await handleCommand(stranger, msg({ id: 7, type: "private" }, CLIENT, "/banks"));
    expect(texts(stranger)).toEqual([]);
  });
});

describe("Mini App API", () => {
  const TOKEN = "123:test-token";
  const enc = new TextEncoder();
  const hmac = async (key: BufferSource, m: string) =>
    crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(m));
  async function initData(userId: number): Promise<string> {
    const f: Record<string, string> = {
      auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAH", user: JSON.stringify({ id: userId, first_name: "Sina", username: "sina" }),
    };
    const check = Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join("\n");
    const hash = [...new Uint8Array(await hmac(await hmac(enc.encode("WebAppData"), TOKEN), check))].map((x) => x.toString(16).padStart(2, "0")).join("");
    return new URLSearchParams({ ...f, hash }).toString();
  }
  const api = makeApp({ env: { ...env, BOT_TOKEN: TOKEN } as Env, fetch: fakeFetch({}) });
  async function call(method: string, path: string, body?: unknown, userId = 1) {
    const res = await handleApi(api, new Request(`https://x.test${path}`, {
      method, headers: { Authorization: `tma ${await initData(userId)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { status: res.status, json: (await res.json()) as any };
  }

  test("add, duplicate, manual moves, history, rename, delete", async () => {
    expect((await call("GET", "/api/banks", undefined, 7)).status).toBe(403);
    const added = await call("POST", "/api/banks", { name: "ملت" });
    const id = added.json.banks.find((b: any) => b.name === "ملت").id as number;
    expect((await call("POST", "/api/banks", { name: "بانک ملت" })).status).toBe(409);
    expect((await call("POST", "/api/banks", { name: "بانک" })).status).toBe(400);

    await call("POST", `/api/banks/${id}/moves`, { direction: "in", amount: "۱۰۰ میلیون", note: "موجودی اولیه" });
    const out = await call("POST", `/api/banks/${id}/moves`, { direction: "out", amount: "1500", note: "کارمزد" });
    expect(out.json.bank.balance).toBe("99998500");
    expect(out.json.items.map((x: any) => x.amount).sort()).toEqual(["-1500", "100000000"]);

    // A payment recorded from the panel on this bank, then moved off it.
    const chat = group();
    await upsertAccount(db, { chatId: chat.id, title: chat.title, type: "supergroup", at: FIXED_NOW, activated: true });
    const paid = await call("POST", `/api/accounts/${chat.id}/payments`, { direction: "PAY", amount: "8500", bankId: id, ref: "9001" });
    expect(paid.json.entry.bankName).toBe("ملت");
    expect((await call("GET", `/api/banks/${id}`)).json.bank.balance).toBe("99990000");
    expect((await call("POST", `/api/accounts/${chat.id}/payments`, { direction: "PAY", amount: "5", asset: "USDT", bankId: id, ref: "abc123" })).status).toBe(400);
    await call("PATCH", `/api/entries/${paid.json.entry.id}`, { bankId: null });
    expect((await getEntry(db, paid.json.entry.id))!.bank).toBeNull();
    await call("PATCH", `/api/entries/${paid.json.entry.id}`, { bankId: id });

    const fee = out.json.items.find((x: any) => x.amount === "-1500");
    expect((await call("DELETE", `/api/banks/${id}/moves/${fee.id}`)).json.bank.balance).toBe("99991500");
    expect((await call("PATCH", `/api/banks/${id}`, { name: "ملت مرکزی" })).json.bank.name).toBe("ملت مرکزی");
    expect((await call("PATCH", `/api/banks/${id}`, { name: "سامان" })).status).toBe(409);

    expect((await call("DELETE", `/api/banks/${id}`)).json).toEqual({ ok: true });
    expect((await listBanks(db)).some((b) => b.id === id)).toBe(false);
    expect((await getEntry(db, paid.json.entry.id))!.bank).toBeNull(); // the payment stays, without a bank
    expect((await call("GET", `/api/banks/${id}`)).status).toBe(404);
  });
});
