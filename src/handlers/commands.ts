import type { Message } from "@grammyjs/types";
import type { App } from "../app";
import { onBroadcastCommand, onCancelCommand, onGroupsCommand } from "../broadcast";
import { renderBalance, renderList } from "../cards";
import { accountName, approvedLedger, getAccount, getSetting, isAdmin, recent } from "../db";
import { openDeals, summarize } from "../ledger";
import { normalize } from "../money";
import { botInfo } from "./update";

const HELP =
  "🤖 <b>دستیار حساب و معاملات</b>\n\n" +
  "در گروه مشتری، ربات را تگ کنید یا روی پیام ربات ریپلای بزنید و ساده بنویسید:\n" +
  "<code>@ربات ۱۰۰ تتر خریدیم به قیمت ۲۷۵ هزار</code>\n" +
  "<code>@ربات فروختیم ۵۰۰ میلیون تومن تتر ۲۶۵ هزار</code> — مبلغ تومانی: مقدار تتر = مبلغ ÷ قیمت\n" +
  "<code>@ربات ۵۰ میلیون تومن کارت به کارت دریافت کردیم</code>\n" +
  "<code>@ربات تسویه کن</code> — تسویه معامله با پرداخت‌های ثبت‌شده\n" +
  "<code>@ربات مانده حساب چنده؟</code> / <code>@ربات قیمت تتر چنده؟</code>\n\n" +
  "روش قدیمی هم کار می‌کند؛ پیام با # شروع شود:\n" +
  "<code>#خرید ۱۰۰ تتر رو قیمت ۲۷۵۰۰۰</code>\n" +
  "<code>#دریافت ۵۰ میلیون تومن</code>\n\n" +
  "ربات یک کارت می‌فرستد؛ با ✅ تایید، معامله در حساب ثبت می‌شود.\n" +
  "مشتری‌ها هم می‌توانند مانده حساب و قیمت‌ها را بپرسند.\n\n" +
  "/deals — لیست معاملات این گروه (مثلاً <code>/deals 30</code>)\n" +
  "/balance — مانده حساب این گروه\n" +
  "/id — شناسه تلگرام شما\n\n" +
  "در چت خصوصی با ربات (فقط مدیران):\n" +
  "/app — پنل مدیریت\n" +
  "/broadcast — ارسال پیام به همه گروه‌ها\n" +
  "/groups — لیست گروه‌های ربات\n" +
  "/cancel — انصراف از ارسال همگانی";

const PRIVATE_NOTE = "این دستور را در گروه مشتری بزنید. مدیران در چت خصوصی می‌توانند نام مشتری را بنویسند و بپرسند.";

async function reply(app: App, msg: Message, text: string, reply_markup?: unknown): Promise<void> {
  await app.tg.call("sendMessage", {
    chat_id: msg.chat.id,
    text,
    parse_mode: "HTML",
    reply_parameters: { message_id: msg.message_id },
    ...(reply_markup ? { reply_markup } : {}),
  });
}

export async function handleCommand(app: App, msg: Message): Promise<void> {
  const [head, ...args] = (msg.text ?? "").trim().split(/\s+/);
  const [rawCmd, target] = head.slice(1).split("@");
  const cmd = rawCmd.toLowerCase();
  if (target) {
    const { username } = await botInfo(app);
    if (username && target.toLowerCase() !== username.toLowerCase()) return;
  }
  const isPrivate = msg.chat.type === "private";

  switch (cmd) {
    case "start":
    case "help":
      return reply(app, msg, HELP);
    case "id": {
      const lines = [`شناسه شما: <code>${msg.from?.id ?? "?"}</code>`];
      if (!isPrivate) lines.push(`شناسه این گروه: <code>${msg.chat.id}</code>`);
      return reply(app, msg, lines.join("\n"));
    }
    case "deals":
    case "balance": {
      if (isPrivate) return reply(app, msg, PRIVATE_NOTE);
      const account = await getAccount(app.db, msg.chat.id);
      const name = account ? accountName(account) : (msg.chat.title ?? "");
      if (cmd === "balance") {
        const ledger = await approvedLedger(app.db, msg.chat.id);
        return reply(app, msg, renderBalance(name, summarize(ledger.map((l) => l.trade)), openDeals(ledger)));
      }
      const n = args[0] !== undefined ? normalize(args[0]) : "";
      const limit = /^\d+$/.test(n) ? Math.max(1, Math.min(40, Number(n))) : 15;
      return reply(app, msg, renderList(name, await recent(app.db, msg.chat.id, limit)));
    }
    case "app": {
      if (!isPrivate || !msg.from || !(await isAdmin(app.db, app.adminIds, msg.from.id))) {
        return reply(app, msg, "این دستور فقط برای مدیران در چت خصوصی است.");
      }
      const origin = await getSetting(app.db, "public_url");
      if (!origin) return reply(app, msg, "هنوز راه‌اندازی (setup) انجام نشده است.");
      const url = `${origin.replace(/\/+$/, "")}/app/`;
      return reply(app, msg, "پنل مدیریت:", { inline_keyboard: [[{ text: "پنل مدیریت", web_app: { url } }]] });
    }
    case "broadcast":
      return isPrivate ? onBroadcastCommand(app, msg) : undefined;
    case "groups":
      return isPrivate ? onGroupsCommand(app, msg) : undefined;
    case "cancel":
      return isPrivate ? onCancelCommand(app, msg) : undefined;
  }
}
