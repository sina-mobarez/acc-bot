import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import type { Message, Update } from "@grammyjs/types";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as broadcast from "../src/broadcast";
import { addAdmin, createEntry, getAccount, getEntry, getSetting, listAccounts, setSetting, setUserState } from "../src/db";
import * as commands from "../src/handlers/commands";
import * as message from "../src/handlers/message";
import { botInfo, handleUpdate, isAddressed } from "../src/handlers/update";
import worker from "../src/index";
import type { NluOutput } from "../src/nlu";
import { FakeNlu, fakeFetch, makeApp } from "./fakes";

const BOT = { id: 99, username: "acc_bot" };
const group = { id: -100, type: "supergroup" as const, title: "G" };
const priv = { id: 5, type: "private" as const, first_name: "U" };
const user = { id: 5, is_bot: false, first_name: "U" };
let uid = 1000;

function msg(over: Record<string, unknown>): Message {
  return { message_id: 1, date: 0, chat: group, from: user, ...over } as unknown as Message;
}
const upd = (m: Message): Update => ({ update_id: ++uid, message: m as Update["message"] });
const mention = { type: "mention", offset: 0, length: 8 };
/** The sender (user 5) is an admin: routing works as for an activated group or an admin DM. */
const adminApp = () => makeApp({ adminIds: new Set([user.id]) });

beforeEach(async () => {
  vi.restoreAllMocks();
  await setSetting(env.DB, "bot_id", String(BOT.id));
  await setSetting(env.DB, "bot_username", BOT.username);
});

describe("update routing", () => {
  test("duplicate update_id is processed once", async () => {
    const spy = vi.spyOn(message, "handleMessage").mockResolvedValue();
    const app = adminApp();
    const u = upd(msg({ text: "#x" }));
    await handleUpdate(app, u);
    await handleUpdate(app, u);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("mention is addressed and stripped", async () => {
    const spy = vi.spyOn(message, "handleMessage").mockResolvedValue();
    const m = msg({ text: "@acc_bot خرید ۱۰۰ تتر", entities: [mention] });
    expect(isAddressed(m, BOT)).toEqual({ text: "خرید ۱۰۰ تتر" });
    await handleUpdate(adminApp(), upd(m));
    expect(spy.mock.calls[0][2]).toBe("خرید ۱۰۰ تتر");
  });

  test("text_mention of the bot is addressed", () => {
    const m = msg({
      text: "Bot خرید",
      entities: [{ type: "text_mention", offset: 0, length: 3, user: { id: BOT.id, is_bot: true, first_name: "Bot" } }],
    });
    expect(isAddressed(m, BOT)).toEqual({ text: "خرید" });
  });

  test("reply to bot message is addressed", async () => {
    const spy = vi.spyOn(message, "handleMessage").mockResolvedValue();
    const replyTo = msg({ from: { id: BOT.id, is_bot: true, first_name: "B" } });
    await handleUpdate(adminApp(), upd(msg({ text: "تایید", reply_to_message: replyTo })));
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), "تایید");
  });

  test("plain group chatter is ignored but the group is tracked", async () => {
    const spy = vi.spyOn(message, "handleMessage").mockResolvedValue();
    await handleUpdate(adminApp(), upd(msg({ text: "سلام بچه ها" })));
    expect(spy).not.toHaveBeenCalled();
    expect((await getAccount(env.DB, group.id))?.botStatus).toBe("member");
  });

  test("# message is addressed", async () => {
    const spy = vi.spyOn(message, "handleMessage").mockResolvedValue();
    await handleUpdate(adminApp(), upd(msg({ text: "#خرید ۵ تتر" })));
    expect(spy.mock.calls[0][2]).toBe("#خرید ۵ تتر");
  });

  test("private text goes to handleMessage, slash commands to handleCommand", async () => {
    const m = vi.spyOn(message, "handleMessage").mockResolvedValue();
    const c = vi.spyOn(commands, "handleCommand").mockResolvedValue();
    await handleUpdate(adminApp(), upd(msg({ chat: priv, text: "hello" })));
    await handleUpdate(adminApp(), upd(msg({ chat: priv, text: "/help" })));
    expect(m).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  test("broadcast_waiting captures any private message but /cancel goes to handleCommand", async () => {
    const b = vi.spyOn(broadcast, "onBroadcastCapture").mockResolvedValue();
    const c = vi.spyOn(commands, "handleCommand").mockResolvedValue();
    const m = vi.spyOn(message, "handleMessage").mockResolvedValue();
    const app = adminApp();
    await setUserState(env.DB, 5, "broadcast_waiting", {}, app.now());
    await handleUpdate(app, upd(msg({ chat: priv, photo: [{}] })));
    await handleUpdate(app, upd(msg({ chat: priv, text: "plain" })));
    await handleUpdate(app, upd(msg({ chat: priv, text: "/cancel" })));
    expect(b).toHaveBeenCalledTimes(2);
    expect(c).toHaveBeenCalledTimes(1);
    expect(m).not.toHaveBeenCalled();
  });

  test("migrate message triggers migration", async () => {
    const e = await createEntry(env.DB, {
      chatId: -200,
      trade: { side: "BUY", amount: new Decimal(10), asset: "USDT", rate: new Decimal(100), note: "", tomanTotal: null },
      createdBy: "ali",
      createdById: 5,
      createdAt: "2026-11-08T12:00:00+03:30",
    });
    const m = msg({ chat: { id: -200, type: "group", title: "Old" }, migrate_to_chat_id: -300 });
    await handleUpdate(adminApp(), upd(m));
    expect((await getEntry(env.DB, e.id))?.chatId).toBe(-300);
  });

  test("my_chat_member kicked marks account", async () => {
    const app = adminApp();
    await handleUpdate(app, upd(msg({ text: "hi" })));
    await handleUpdate(app, {
      update_id: ++uid,
      my_chat_member: { chat: group, from: user, date: 0, old_chat_member: {}, new_chat_member: { status: "kicked" } },
    } as unknown as Update);
    expect((await getAccount(env.DB, group.id))?.botStatus).toBe("kicked");
  });

  test("private-chat my_chat_member creates no account", async () => {
    await handleUpdate(adminApp(), {
      update_id: ++uid,
      my_chat_member: {
        chat: { id: 4242, type: "private", first_name: "U" },
        from: user,
        date: 0,
        old_chat_member: {},
        new_chat_member: { status: "kicked" },
      },
    } as unknown as Update);
    expect(await getAccount(env.DB, 4242)).toBeNull();
  });

  test("botInfo reads settings", async () => {
    expect(await botInfo(adminApp())).toEqual(BOT);
  });
});

describe("strangers (item 15)", () => {
  const NOBITEX = { stats: { "usdt-rls": { latest: "2660000", bestBuy: "2659000", bestSell: "2661000" } } };
  const stranger = { id: 6060, is_bot: false, first_name: "S" };
  const dm = { id: 6060, type: "private" as const, first_name: "S" };
  let nextGroup = -7000;
  const freshGroupChat = () => ({ id: --nextGroup, type: "supergroup" as const, title: `G${nextGroup}` });
  /** Admin is user 1 (makeApp default). Counts every external fetch (Nobitex, KuCoin). */
  function watched(...script: (NluOutput | null)[]) {
    const fetched: string[] = [];
    const routes = fakeFetch({ "apiv2.nobitex.ir": NOBITEX });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input));
      return routes(input, init);
    }) as typeof fetch;
    const app = makeApp({ fetch: f, nlu: new FakeNlu(...script) });
    return { app, fetched };
  }
  const texts = (app: ReturnType<typeof makeApp>) =>
    app.tg.calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text));

  test("a non-admin DM gets no reply except /id and /help", async () => {
    const { app, fetched } = watched({ intent: "chitchat", reply: "سلام" });
    for (const text of ["سلام", "#خرید ۱۰ تتر ۲۶۶۰۰۰", "/app", "/broadcast", "/groups", "/balance"]) {
      await handleUpdate(app, upd(msg({ chat: dm, from: stranger, text })));
    }
    expect(app.tg.calls).toHaveLength(0);
    expect(app.nlu.inputs).toHaveLength(0);
    expect(fetched).toHaveLength(0);
    await handleUpdate(app, upd(msg({ chat: dm, from: stranger, text: "/id" })));
    await handleUpdate(app, upd(msg({ chat: dm, from: stranger, text: "/help" })));
    await handleUpdate(app, upd(msg({ chat: dm, from: stranger, text: "/start" })));
    const out = texts(app);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("<code>6060</code>");
  });

  test("a stranger in broadcast_waiting state is not captured", async () => {
    const b = vi.spyOn(broadcast, "onBroadcastCapture").mockResolvedValue();
    const app = makeApp();
    await setUserState(env.DB, stranger.id, "broadcast_waiting", {}, app.now());
    await handleUpdate(app, upd(msg({ chat: dm, from: stranger, text: "x" })));
    expect(b).not.toHaveBeenCalled();
  });

  test("a group is silent until an admin speaks; then clients are answered", async () => {
    const g = freshGroupChat();
    const client = { id: 7070, is_bot: false, first_name: "C" };
    const admin = { id: 1, is_bot: false, first_name: "A" };
    const { app, fetched } = watched({ intent: "query_price", coins: [] });
    const ask = () => msg({ chat: g, from: client, text: "@acc_bot قیمت تتر؟", entities: [mention] });
    await handleUpdate(app, upd(ask()));
    await handleUpdate(app, upd(msg({ chat: g, from: client, text: "/balance" })));
    expect(app.tg.calls).toHaveLength(0);
    expect(app.nlu.inputs).toHaveLength(0);
    expect(fetched).toHaveLength(0);
    const tracked = (await getAccount(env.DB, g.id))!;
    expect(tracked.title).toBe(g.title);
    expect(tracked.activated).toBe(false);
    expect((await listAccounts(env.DB)).some((a) => a.chatId === g.id)).toBe(false);

    await handleUpdate(app, upd(msg({ chat: g, from: admin, text: "سلام" }))); // plain chatter is enough
    expect((await getAccount(env.DB, g.id))!.activated).toBe(true);
    expect(app.tg.calls).toHaveLength(0);
    await handleUpdate(app, upd(ask()));
    expect(app.nlu.inputs).toHaveLength(1);
    expect(texts(app).at(-1)).toContain("قیمت");
    expect((await listAccounts(env.DB)).some((a) => a.chatId === g.id)).toBe(true);
  });

  test("an admin adding the bot activates the group; a stranger adding it does not", async () => {
    const add = (chat: ReturnType<typeof freshGroupChat>, from: typeof user) =>
      handleUpdate(makeApp(), {
        update_id: ++uid,
        my_chat_member: { chat, from, date: 0, old_chat_member: {}, new_chat_member: { status: "member" } },
      } as unknown as Update);
    const byAdmin = freshGroupChat();
    const byStranger = freshGroupChat();
    await add(byAdmin, { id: 1, is_bot: false, first_name: "A" });
    await add(byStranger, stranger);
    expect((await getAccount(env.DB, byAdmin.id))!.activated).toBe(true);
    expect((await getAccount(env.DB, byStranger.id))!.activated).toBe(false);
  });
});

describe("worker routes", () => {
  const testEnv = { ...env, WEBHOOK_SECRET: "s3cret", ADMIN_IDS: "1", BOT_TOKEN: "t", GEMINI_API_KEY: "k" } as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const H = "X-Telegram-Bot-Api-Secret-Token";
  const R = (url: string, init?: RequestInit) => new Request(url, init) as Request<unknown, IncomingRequestCfProperties>;

  test("webhook rejects wrong secret with 401", async () => {
    const wrong = R("https://x.dev/tg", { method: "POST", headers: { [H]: "nope" }, body: "{}" });
    expect((await worker.fetch(wrong, testEnv, ctx)).status).toBe(401);
    const none = R("https://x.dev/tg", { method: "POST", body: "{}" });
    expect((await worker.fetch(none, testEnv, ctx)).status).toBe(401);
    const setup = R("https://x.dev/setup", { method: "POST" });
    expect((await worker.fetch(setup, testEnv, ctx)).status).toBe(401);
  });

  test("valid secret returns 200 and defers the work", async () => {
    const waits: Promise<unknown>[] = [];
    const c = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const req = R("https://x.dev/tg", {
      method: "POST",
      headers: { [H]: "s3cret" },
      body: JSON.stringify({ update_id: ++uid }),
    });
    expect((await worker.fetch(req, testEnv, c)).status).toBe(200);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
  });

  test("ADMIN_IDS unset: /tg still answers /id and /api does not throw", async () => {
    const noAdmins = { ...testEnv, ADMIN_IDS: undefined } as unknown as Env;
    const sentTexts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/sendMessage")) sentTexts.push(JSON.parse(String(init?.body)).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as typeof fetch;
    try {
      const waits: Promise<unknown>[] = [];
      const c = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
      const update = { update_id: ++uid, message: msg({ chat: priv, text: "/id" }) };
      const req = R("https://x.dev/tg", { method: "POST", headers: { [H]: "s3cret" }, body: JSON.stringify(update) });
      expect((await worker.fetch(req, noAdmins, c)).status).toBe(200);
      await Promise.all(waits);
      expect(sentTexts.some((t) => t.includes(`<code>${user.id}</code>`))).toBe(true);
      expect((await worker.fetch(R("https://x.dev/api/settings"), noAdmins, ctx)).status).toBe(401);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("/api/* requires Mini App auth", async () => {
    const res = await worker.fetch(R("https://x.dev/api/foo"), testEnv, ctx);
    expect(res.status).toBe(401);
  });

  test("setup stores bot info and public_url; the Mini App button is per admin chat", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await addAdmin(env.DB, 31, "db admin", null, "2026-11-08T10:00:00+03:30");
    await addAdmin(env.DB, 32, "unreachable", null, "2026-11-08T10:00:00+03:30");
    const calls: string[] = [];
    const menus: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url.split("/").pop()!);
      if (url.endsWith("setChatMenuButton")) {
        const body = JSON.parse(String(init?.body));
        menus.push(body);
        if (body.chat_id === 32) return new Response(JSON.stringify({ ok: false, error_code: 400, description: "chat not found" }));
      }
      const result = url.endsWith("getMe") ? { id: 77, username: "setup_bot" } : true;
      return new Response(JSON.stringify({ ok: true, result }));
    }) as typeof fetch;
    try {
      const req = R("https://bot.example.dev/setup", { method: "POST", headers: { [H]: "s3cret" } });
      const res = await worker.fetch(req, testEnv, ctx);
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual(["getMe", "setWebhook", "setMyCommands", "setMyCommands", ...Array(4).fill("setChatMenuButton")]);
    expect(menus[0]).toEqual({ menu_button: { type: "commands" } });
    const app = { type: "web_app", text: "پنل مدیریت", web_app: { url: "https://bot.example.dev/app/" } };
    expect(menus.slice(1)).toEqual([1, 31, 32].map((chat_id) => ({ chat_id, menu_button: app })));
    expect(await getSetting(env.DB, "bot_username")).toBe("setup_bot");
    expect(await getSetting(env.DB, "public_url")).toBe("https://bot.example.dev");
  });
});
