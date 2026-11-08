import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import {
  addAdmin, createEntry, getEntry, getSetting, listAccounts, type NewEntry, setCardMessage, setSetting, transition,
  upsertAccount,
} from "../src/db";
import { handleApi } from "../src/miniapp/api";
import { validateInitData } from "../src/miniapp/auth";
import type { Trade } from "../src/trade";
import { fakeFetch, makeApp, type TestApp } from "./fakes";

const db = env.DB;
const D = (s: string | number) => new Decimal(s);
const AT = "2026-11-08T10:00:00+03:30";
const TOKEN = "123:test-token";
const enc = new TextEncoder();

async function hmac(key: BufferSource, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** A correctly signed initData string, built with Telegram's documented steps. */
async function signedInitData(userId: number, authDate = Math.floor(Date.now() / 1000), token = TOKEN): Promise<string> {
  const fields: Record<string, string> = {
    auth_date: String(authDate),
    query_id: "AAH",
    user: JSON.stringify({ id: userId, first_name: "Sina", username: "sina" }),
  };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = hex(await hmac(await hmac(enc.encode("WebAppData"), token), check));
  return new URLSearchParams({ ...fields, hash }).toString();
}

let nextChat = 9000;
const freshChat = () => -(++nextChat * 13);
const newAccount = async (title = "علی") => {
  const chatId = freshChat();
  await upsertAccount(db, { chatId, title, type: "supergroup", at: AT });
  return chatId;
};
const deal = (over: Partial<Trade> = {}): Trade => ({
  side: "BUY", amount: D(100), asset: "USDT", rate: D(275000), note: "", tomanTotal: null, ...over,
});
const pay = (over: Partial<Trade> = {}): Trade => ({
  side: "RECEIVE", amount: D(100), asset: "USDT", rate: null, note: "", tomanTotal: null, ...over,
});
const mk = (chatId: number, t: Trade, over: Partial<NewEntry> = {}) =>
  createEntry(db, { chatId, trade: t, createdBy: "ali", createdById: 5, createdAt: AT, ...over });
const approved = async (chatId: number, t: Trade, over: Partial<NewEntry> = {}) => {
  const e = await mk(chatId, t, over);
  await transition(db, [e.id], "pending", "approved");
  return e;
};

const appFor = () => makeApp({ env: { ...env, BOT_TOKEN: TOKEN } as Env, fetch: fakeFetch({}) });

async function call(app: TestApp, method: string, path: string, body?: unknown, userId = 1) {
  const res = await handleApi(app, new Request(`https://x.test${path}`, {
    method,
    headers: { Authorization: `tma ${await signedInitData(userId)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, json: (await res.json()) as any };
}

describe("validateInitData", () => {
  const now = Math.floor(Date.now() / 1000);

  test("accepts a correctly signed string", async () => {
    expect(await validateInitData(await signedInitData(42, now), TOKEN, now)).toEqual({ id: 42, name: "@sina" });
  });

  test("rejects a tampered string, a wrong token and an expired auth_date", async () => {
    const good = await signedInitData(42, now);
    expect(await validateInitData(good.replace("42", "43"), TOKEN, now)).toBeNull();
    expect(await validateInitData(good, "other:token", now)).toBeNull();
    expect(await validateInitData(good.replace(/hash=[0-9a-f]+/, "hash=zz"), TOKEN, now)).toBeNull();
    expect(await validateInitData(good.replace(/&?hash=[0-9a-f]+/, ""), TOKEN, now)).toBeNull();
    const old = await signedInitData(42, now - 86401);
    expect(await validateInitData(old, TOKEN, now)).toBeNull();
    expect(await validateInitData(await signedInitData(42, now - 86400), TOKEN, now)).not.toBeNull();
  });
});

describe("auth", () => {
  test("401 without header or with a bad one", async () => {
    const app = appFor();
    for (const headers of [{} as Record<string, string>, { Authorization: "tma garbage" }, { Authorization: "Bearer x" }]) {
      const res = await handleApi(app, new Request("https://x.test/api/dashboard", { headers }));
      expect(res.status).toBe(401);
    }
  });

  test("403 for a validly signed non-admin, on every route (nothing reaches Telegram)", async () => {
    const app = appFor();
    const chat = await newAccount();
    for (const [m, p] of [
      ["GET", "/api/dashboard"], ["GET", "/api/accounts"], ["GET", `/api/accounts/${chat}`],
      ["PATCH", `/api/accounts/${chat}`], ["POST", `/api/accounts/${chat}/payments`], ["GET", "/api/entries"],
      ["POST", "/api/entries/1/approve"], ["POST", "/api/entries/1/cancel"], ["PATCH", "/api/entries/1"],
      ["GET", "/api/admins"], ["POST", "/api/admins"], ["DELETE", "/api/admins/5"],
      ["GET", "/api/settings"], ["PATCH", "/api/settings"],
    ]) {
      expect((await call(app, m, p, m === "GET" || m === "DELETE" ? undefined : {}, 777)).status, `${m} ${p}`).toBe(403);
    }
    expect(app.tg.calls).toHaveLength(0);
  });

  test("a db admin passes", async () => {
    await addAdmin(db, 888, "x", null, AT);
    expect((await call(appFor(), "GET", "/api/settings", undefined, 888)).status).toBe(200);
  });
});

describe("dashboard", () => {
  test("per-asset totals, never converted", async () => {
    await db.batch([db.prepare("DELETE FROM entries"), db.prepare("DELETE FROM accounts")]);
    const a = await newAccount("الف");
    const b = await newAccount("ب");
    await approved(a, pay({ side: "PAY", asset: "IRT", amount: D(10_000_000) })); // we paid: client owes 10M
    await approved(b, pay({ side: "RECEIVE", asset: "USDT", amount: D(50) })); // client paid ahead: we owe 50
    await mk(b, deal()); // pending: not in the ledger, counted as pending
    const { status, json } = await call(appFor(), "GET", "/api/dashboard");
    expect(status).toBe(200);
    expect(json.receivable).toEqual({ IRT: "10000000" });
    expect(json.payable).toEqual({ USDT: "50" });
    expect(json.pendingCount).toBe(1);
    expect(json.usdt).toBeNull();
    expect(json.todayVolumeUsdt).toBe("0");
    expect(json.topDebtors).toEqual([{ chatId: a, name: "الف", owed: { IRT: "10000000" } }]);
  });
});

describe("accounts", () => {
  test("list hides archived unless asked; detail has owed, open deals and entries; patch updates", async () => {
    const chat = await newAccount("رضا");
    const d = await approved(chat, deal());
    const app = appFor();
    let r = await call(app, "GET", "/api/accounts");
    expect(r.json.accounts.find((a: any) => a.chatId === chat).owed).toEqual({ USDT: "100", IRT: "-27500000" });

    r = await call(app, "PATCH", `/api/accounts/${chat}`, { display_name: "رضا ۲", archived: true, humor_on: false });
    expect(r.status).toBe(200);
    expect(r.json.account).toMatchObject({ name: "رضا ۲", archived: true, humor_on: false });
    expect((await call(app, "GET", "/api/accounts")).json.accounts.some((a: any) => a.chatId === chat)).toBe(false);
    expect((await call(app, "GET", "/api/accounts?archived=1")).json.accounts.some((a: any) => a.chatId === chat)).toBe(true);

    r = await call(app, "GET", `/api/accounts/${chat}`);
    expect(r.json.openDeals).toHaveLength(1);
    expect(r.json.openDeals[0]).toMatchObject({ id: d.id, code: d.code });
    expect(r.json.openDeals[0].legs[0]).toEqual({ asset: "USDT", dir: "client_owes", total: "100", remaining: "100" });
    expect(r.json.entries).toHaveLength(1);

    expect((await call(app, "PATCH", `/api/accounts/${chat}`, { humor_on: "yes" })).status).toBe(400);
    expect((await call(app, "GET", "/api/accounts/-1")).status).toBe(404);
    expect((await listAccounts(db, { includeArchived: true })).find((a) => a.chatId === chat)?.displayName).toBe("رضا ۲");
  });

  test("post payment with Persian amount «۵۰ میلیون» creates approved RECEIVE 50000000 and notifies group", async () => {
    const chat = await newAccount();
    const app = appFor();
    const { status, json } = await call(app, "POST", `/api/accounts/${chat}/payments`, {
      direction: "RECEIVE", amount: "۵۰ میلیون", note: "کارت",
    });
    expect(status).toBe(200);
    expect(json.entry).toMatchObject({
      kind: "RECEIVE", amount: "50000000", asset: "IRT", status: "approved", note: "کارت", decidedBy: "@sina",
    });
    expect((await getEntry(db, json.entry.id))?.status).toBe("approved");
    const sent = app.tg.calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0].params.chat_id).toBe(chat);
  });

  test("payment validation and linked deal checks", async () => {
    const chat = await newAccount();
    const other = await newAccount();
    const d = await approved(chat, deal({ rate: null }));
    const foreign = await approved(other, deal({ rate: null }));
    const app = appFor();
    const url = `/api/accounts/${chat}/payments`;
    expect((await call(app, "POST", url, { direction: "X", amount: "5" })).status).toBe(400);
    expect((await call(app, "POST", url, { direction: "PAY", amount: "abc" })).status).toBe(400);
    expect((await call(app, "POST", url, { direction: "PAY", amount: "0" })).status).toBe(400);
    expect((await call(app, "POST", url, { direction: "PAY", amount: "5", linkedDealId: foreign.id })).status).toBe(400);
    expect((await call(app, "POST", "/api/accounts/-1/payments", { direction: "PAY", amount: "5" })).status).toBe(404);
    const ok = await call(app, "POST", url, { direction: "RECEIVE", amount: "40", asset: "تتر", linkedDealId: d.id });
    expect(ok.status).toBe(200);
    expect(ok.json.entry).toMatchObject({ asset: "USDT", amount: "40", linkedDealId: d.id });
  });
});

describe("entries", () => {
  test("list filters and caps the limit", async () => {
    const chat = await newAccount();
    for (let i = 0; i < 3; i++) await mk(chat, deal());
    await approved(chat, pay());
    const app = appFor();
    const all = await call(app, "GET", `/api/entries?chatId=${chat}&limit=500`);
    expect(all.json.entries).toHaveLength(4);
    const pend = await call(app, "GET", `/api/entries?chatId=${chat}&status=pending&kind=BUY&limit=2`);
    expect(pend.json.entries).toHaveLength(2);
    const older = await call(app, "GET", `/api/entries?chatId=${chat}&before=${pend.json.entries[1].id}`);
    expect(older.json.entries.every((e: any) => e.id < pend.json.entries[1].id)).toBe(true);
    expect((await call(app, "GET", "/api/entries?status=bogus")).status).toBe(400);
  });

  test("approve edits the group card; a second decision is 409", async () => {
    const chat = await newAccount();
    const e = await mk(chat, deal());
    await setCardMessage(db, e.id, 77);
    const app = appFor();
    const r = await call(app, "POST", `/api/entries/${e.id}/approve`);
    expect(r.status).toBe(200);
    expect(r.json.entry.status).toBe("approved");
    const edits = app.tg.calls.filter((c) => c.method === "editMessageText");
    expect(edits).toHaveLength(1);
    expect(edits[0].params).toMatchObject({ chat_id: chat, message_id: 77 });
    expect((await call(app, "POST", `/api/entries/${e.id}/approve`)).status).toBe(409);
    expect((await call(app, "POST", `/api/entries/${e.id}/reject`)).status).toBe(409);
    expect((await call(app, "POST", "/api/entries/999999/approve")).status).toBe(404);
  });

  test("reject a pending entry", async () => {
    const chat = await newAccount();
    const e = await mk(chat, deal());
    const r = await call(appFor(), "POST", `/api/entries/${e.id}/reject`);
    expect(r.json.entry).toMatchObject({ status: "rejected", decidedBy: "@sina" });
  });

  test("settlement batch is approved all-or-nothing and re-checked (R18)", async () => {
    const chat = await newAccount();
    const d = await approved(chat, deal({ rate: null }));
    const p1 = await mk(chat, pay({ amount: D(60) }), { linkedDealId: d.id, batchId: "b1" });
    const p2 = await mk(chat, pay({ amount: D(40) }), { linkedDealId: d.id, batchId: "b1" });
    const app = appFor();
    expect((await call(app, "POST", `/api/entries/${p1.id}/approve`)).status).toBe(200);
    expect((await getEntry(db, p2.id))?.status).toBe("approved");

    // Two competing settlements for the same remaining leg: the second is stale.
    const d2 = await approved(chat, deal({ rate: null }));
    const q1 = await mk(chat, pay({ amount: D(100) }), { linkedDealId: d2.id, batchId: "b2" });
    const q2 = await mk(chat, pay({ amount: D(100) }), { linkedDealId: d2.id, batchId: "b3" });
    expect((await call(app, "POST", `/api/entries/${q1.id}/approve`)).status).toBe(200);
    app.tg.calls.length = 0;
    const stale = await call(app, "POST", `/api/entries/${q2.id}/approve`);
    expect(stale.status).toBe(409);
    const notice = app.tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain("رد شد");
    expect(notice[0]).not.toContain("تایید از پنل");
    expect((await getEntry(db, q2.id))?.status).toBe("rejected");
  });

  test("edit entry records event and notifies; toman deal recomputes amount from a new rate", async () => {
    const chat = await newAccount();
    const e = await approved(chat, deal({ amount: D("1818.18"), rate: D(275000), tomanTotal: D(500_000_000) }));
    await setCardMessage(db, e.id, 12);
    const app = appFor();
    const r = await call(app, "PATCH", `/api/entries/${e.id}`, { rate: "۲۵۰,۰۰۰", note: "اصلاح" });
    expect(r.status).toBe(200);
    expect(r.json.entry).toMatchObject({ rate: "250000", amount: "2000", tomanTotal: "500000000", note: "اصلاح" });
    const events = await db.prepare("SELECT action FROM entry_events WHERE entry_id = ?").bind(e.id).all();
    expect(events.results.map((x: any) => x.action)).toEqual(["edit"]);
    expect(app.tg.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    expect(app.tg.calls.filter((c) => c.method === "editMessageText")).toHaveLength(1);

    // A new asset amount replaces the toman figure; the rate stays (tomanTotal => rate invariant).
    const r2 = await call(app, "PATCH", `/api/entries/${e.id}`, { amount: "۱ هزار" });
    expect(r2.json.entry).toMatchObject({ amount: "1000", tomanTotal: null, rate: "250000" });
  });

  test("edit rejects payments with a rate, bad values, and finished entries", async () => {
    const chat = await newAccount();
    const p = await approved(chat, pay());
    const rej = await mk(chat, deal());
    await transition(db, [rej.id], "pending", "rejected");
    const app = appFor();
    expect((await call(app, "PATCH", `/api/entries/${p.id}`, { rate: "5" })).status).toBe(400);
    expect((await call(app, "PATCH", `/api/entries/${p.id}`, { amount: "-5" })).status).toBe(400);
    expect((await call(app, "PATCH", `/api/entries/${p.id}`, {})).status).toBe(400);
    expect((await call(app, "PATCH", `/api/entries/${rej.id}`, { note: "x" })).status).toBe(409);
    expect((await call(app, "PATCH", `/api/entries/${p.id}`, { amount: "30" })).json.entry.amount).toBe("30");
  });

  test("cancel entry via api unlinks payments", async () => {
    const chat = await newAccount();
    const d = await approved(chat, deal({ rate: null }));
    const p = await approved(chat, pay({ amount: D(30) }), { linkedDealId: d.id });
    await setCardMessage(db, d.id, 5);
    const app = appFor();
    const r = await call(app, "POST", `/api/entries/${d.id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ unlinked: true, entry: { status: "cancelled" } });
    expect(await getEntry(db, p.id)).toMatchObject({ status: "approved", linkedDealId: null });
    const sent = app.tg.calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0].params.chat_id).toBe(chat);
    expect((await call(app, "POST", `/api/entries/${d.id}/cancel`)).status).toBe(409);
  });

  test("cancel a pending entry", async () => {
    const chat = await newAccount();
    const e = await mk(chat, deal());
    expect((await call(appFor(), "POST", `/api/entries/${e.id}/cancel`)).json.entry.status).toBe("cancelled");
  });
});

describe("admins and settings", () => {
  test("env admins are listed non-removable; add and remove db admins", async () => {
    const app = appFor();
    const list = await call(app, "GET", "/api/admins");
    expect(list.json.admins).toContainEqual({ userId: 1, name: "", removable: false, source: "env" });
    const added = await call(app, "POST", "/api/admins", { userId: 4242, name: "Reza" });
    expect(added.json.admins).toContainEqual({ userId: 4242, name: "Reza", removable: true, source: "db" });
    expect((await call(app, "POST", "/api/admins", { userId: "x", name: "a" })).status).toBe(400);
    expect((await call(app, "DELETE", "/api/admins/1")).status).toBe(400);
    expect((await call(app, "DELETE", "/api/admins/4242")).status).toBe(200);
    expect((await call(app, "DELETE", "/api/admins/4242")).status).toBe(404);
  });

  test("deviation_pct is validated as a positive decimal (R20)", async () => {
    const app = appFor();
    await db.prepare("DELETE FROM settings WHERE key = 'deviation_pct'").run();
    expect((await call(app, "GET", "/api/settings")).json).toEqual({ deviation_pct: "3" });
    expect((await call(app, "PATCH", "/api/settings", { deviation_pct: "۵.۵" })).json).toEqual({ deviation_pct: "5.5" });
    expect(await getSetting(db, "deviation_pct")).toBe("5.5");
    for (const bad of ["0", "-1", "abc", "", "1e3", null, {}]) {
      expect((await call(app, "PATCH", "/api/settings", { deviation_pct: bad })).status, String(bad)).toBe(400);
    }
    expect(await getSetting(db, "deviation_pct")).toBe("5.5");
    await setSetting(db, "deviation_pct", "garbage");
    expect((await call(app, "GET", "/api/settings")).json).toEqual({ deviation_pct: "3" });
    await db.prepare("DELETE FROM settings WHERE key = 'deviation_pct'").run();
  });
});
