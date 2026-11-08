import type { Update } from "@grammyjs/types";
import type { App } from "./app";
import { nowTehran } from "./app";
import { runCron } from "./cron";
import { parseAdminIds, setSetting } from "./db";
import { handleUpdate } from "./handlers/update";
import { handleApi } from "./miniapp/api";
import { createGeminiNlu } from "./nlu";
import { fetchCoinUsdt, fetchUsdtToman } from "./prices";
import { createTg } from "./telegram";

function makeApp(env: Env, ctx: ExecutionContext): App {
  return {
    env,
    db: env.DB,
    tg: createTg(env.BOT_TOKEN, fetch),
    nlu: createGeminiNlu(env.GEMINI_API_KEY, env.GEMINI_MODEL, fetch),
    fetch,
    now: nowTehran,
    adminIds: parseAdminIds(env.ADMIN_IDS),
    defer: (p) => ctx.waitUntil(p),
  };
}

const authorized = (req: Request, env: Env): boolean =>
  !!env.WEBHOOK_SECRET && req.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.WEBHOOK_SECRET;

const GROUP_COMMANDS = ["deals", "balance", "help", "id"];
const PRIVATE_COMMANDS = ["app", "broadcast", "groups", "cancel", "help", "id"];

const DESCRIPTIONS: Record<string, string> = {
  deals: "آخرین معاملات",
  balance: "مانده حساب",
  help: "راهنما",
  id: "نمایش شناسه",
  app: "پنل مدیریت",
  broadcast: "ارسال پیام همگانی",
  groups: "فهرست گروه‌ها",
  cancel: "لغو عملیات",
};

const commandList = (names: string[]) => names.map((command) => ({ command, description: DESCRIPTIONS[command] }));

async function setup(app: App, origin: string): Promise<Record<string, unknown>> {
  const me = await app.tg.call<{ id: number; username: string }>("getMe", {});
  await setSetting(app.db, "bot_id", String(me.id));
  await setSetting(app.db, "bot_username", me.username);
  await setSetting(app.db, "public_url", origin);
  const webhook = await app.tg.call("setWebhook", {
    url: `${origin}/tg`,
    secret_token: app.env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    drop_pending_updates: true,
  });
  const groupCommands = await app.tg.call("setMyCommands", {
    commands: commandList(GROUP_COMMANDS),
    scope: { type: "all_group_chats" },
  });
  const privateCommands = await app.tg.call("setMyCommands", {
    commands: commandList(PRIVATE_COMMANDS),
    scope: { type: "all_private_chats" },
  });
  const menuButton = await app.tg.call("setChatMenuButton", {
    menu_button: { type: "web_app", text: "پنل مدیریت", web_app: { url: `${origin}/app/` } },
  });
  return { me, webhook, groupCommands, privateCommands, menuButton };
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/health/prices") {
      const [nobitex, kucoinBtc] = await Promise.all([fetchUsdtToman(fetch), fetchCoinUsdt("BTC", fetch)]);
      return Response.json({
        nobitex: nobitex?.latest.toString() ?? null,
        kucoinBtc: kucoinBtc?.toString() ?? null,
      });
    }

    if (req.method === "POST" && pathname === "/tg") {
      if (!authorized(req, env)) return new Response("unauthorized", { status: 401 });
      let update: Update;
      try {
        update = await req.json<Update>();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      const app = makeApp(env, ctx);
      app.defer(handleUpdate(app, update));
      return new Response("ok");
    }

    if (req.method === "POST" && pathname === "/setup") {
      if (!authorized(req, env)) return new Response("unauthorized", { status: 401 });
      try {
        return Response.json(await setup(makeApp(env, ctx), url.origin));
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502 });
      }
    }

    if (pathname.startsWith("/api/")) return handleApi(makeApp(env, ctx), req);

    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx): Promise<void> {
    await runCron(makeApp(env, ctx), new Date(event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
