import type { Message } from "@grammyjs/types";
import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import { createEntry, setSetting, transition, upsertAccount } from "../src/db";
import { handleCommand } from "../src/handlers/commands";
import { makeApp } from "./fakes";

const db = env.DB;
const AT = "2026-11-08T10:00:00+03:30";
let nextChat = 9000;
const freshChat = () => -(++nextChat * 13);

const msg = (text: string, chatId: number, type: "private" | "supergroup" = "supergroup", userId = 1): Message =>
  ({
    message_id: 7, date: 0, text,
    chat: type === "private" ? { id: chatId, type } : { id: chatId, type, title: "گروه" },
    from: { id: userId, is_bot: false, first_name: "A" },
  }) as unknown as Message;

const sent = (app: ReturnType<typeof makeApp>) =>
  app.tg.calls.filter((c) => c.method === "sendMessage").map((c) => c.params);

async function seed(chatId: number, n: number) {
  await upsertAccount(db, { chatId, title: "گروه", type: "supergroup", at: AT, activated: true });
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = await createEntry(db, {
      chatId, createdBy: "ali", createdById: 5, createdAt: AT,
      trade: { side: "BUY", amount: new Decimal(100 + i), asset: "USDT", rate: new Decimal(275000), note: "", tomanTotal: null },
    });
    ids.push(e.id);
  }
  return ids;
}
const rows = (text: unknown) => String(text).match(/D-\d{5}/g)?.length ?? 0;

describe("commands", () => {
  test("/deals ۳۰ lists up to 30", async () => {
    const chat = freshChat();
    await seed(chat, 35);
    const app = makeApp();
    await handleCommand(app, msg("/deals ۳۰", chat));
    expect(rows(sent(app)[0].text)).toBe(30);
  });

  test("/deals 100 caps at 40", async () => {
    const chat = freshChat();
    await seed(chat, 45);
    const app = makeApp();
    await handleCommand(app, msg("/deals 100", chat));
    expect(rows(sent(app)[0].text)).toBe(40);
  });

  test("/balance in a group uses that chat", async () => {
    const chat = freshChat();
    const ids = await seed(chat, 1);
    await transition(db, ids, "pending", "approved");
    const app = makeApp();
    await handleCommand(app, msg("/balance", chat));
    const p = sent(app);
    expect(p[0].chat_id).toBe(chat);
    expect(String(p[0].text)).toContain("گروه");
  });

  test("/balance in private chat points to a group", async () => {
    const app = makeApp();
    await handleCommand(app, msg("/balance", 42, "private"));
    expect(String(sent(app)[0].text)).toContain("گروه");
  });

  test("/app from a non-admin is denied", async () => {
    await setSetting(db, "public_url", "https://x.example");
    const app = makeApp();
    await handleCommand(app, msg("/app", 99, "private", 99));
    expect(sent(app)[0].reply_markup).toBeUndefined();
  });

  test("/app from an admin gives a web_app button", async () => {
    await setSetting(db, "public_url", "https://x.example");
    const app = makeApp();
    await handleCommand(app, msg("/app", 1, "private", 1));
    expect(sent(app)[0].reply_markup).toEqual({
      inline_keyboard: [[{ text: "پنل مدیریت", web_app: { url: "https://x.example/app/" } }]],
    });
  });

  test("/help@acc_bot works", async () => {
    const app = makeApp();
    await handleCommand(app, msg("/help@acc_bot", freshChat()));
    expect(String(sent(app)[0].text)).toContain("/deals");
  });
});
