import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  editKeyboard,
  entryKeyboard,
  jalali,
  renderBalance,
  renderEntry,
  renderReminder,
  settlementKeyboard,
} from "../src/cards";
import { dealCode, type Entry } from "../src/db";
import { summarize } from "../src/ledger";
import { createTg, isForbidden, TgError } from "../src/telegram";
import type { Trade } from "../src/trade";
import { CLIENT_WRITE_REFUSALS, NUDGE_LINES, ORDINARY_LINES, pick } from "../src/jokes";
import { FakeTg } from "./fakes";

const D = (s: string | number) => new Decimal(s);

const trade = (over: Partial<Trade> = {}): Trade => ({
  side: "BUY",
  amount: D(1000),
  asset: "USDT",
  rate: D(266000),
  note: "",
  tomanTotal: null,
  ...over,
});

const entry = (over: Partial<Entry> = {}): Entry => ({
  id: 7,
  chatId: -100,
  code: dealCode(7),
  trade: trade(),
  status: "pending",
  batchId: null,
  linkedDealId: null,
  cardMsgId: null,
  joke: null,
  createdBy: "Ali",
  createdById: 1,
  createdAt: "2026-10-17T19:05:00+03:30",
  decidedBy: null,
  decidedAt: null,
  cancelledBy: null,
  cancelledAt: null,
  ...over,
});

describe("jalali", () => {
  it("formats Tehran time in the Persian calendar", () => {
    expect(jalali("2026-10-17T19:05:00+03:30")).toBe("۱۴۰۵/۰۷/۲۵ – ۱۹:۰۵");
  });
});

describe("renderEntry", () => {
  it("shows the toman breakdown for a by-toman trade", () => {
    const t = trade({ amount: D("1893.94"), rate: D(264000), tomanTotal: D(500000000) });
    expect(renderEntry(entry({ trade: t }))).toContain("۵۰۰٬۰۰۰٬۰۰۰ ÷ ۲۶۴٬۰۰۰");
  });

  it("warns and shows the Nobitex price above the alert threshold only", () => {
    const o = { ref: D(250000), alertPct: D(3) };
    const high = renderEntry(entry(), { ...o, deviationPct: D("6.4") });
    expect(high).toContain("⚠️");
    expect(high).toContain("۲۵۰٬۰۰۰");
    expect(renderEntry(entry(), { ...o, deviationPct: D(3) })).not.toContain("⚠️");
  });

  it("escapes user-supplied text", () => {
    const html = renderEntry(entry({ trade: trade({ note: "<b>x</b>" }), createdBy: "<i>Bob" }));
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;Bob");
  });

  it("appends the joke in italics before the status", () => {
    const html = renderEntry(entry({ joke: "شوخی <u>" }));
    expect(html).toContain("<i>شوخی &lt;u&gt;</i>");
    expect(html.indexOf("شوخی")).toBeLessThan(html.indexOf("وضعیت"));
  });
});

describe("keyboards", () => {
  const cbs = (k: ReturnType<typeof entryKeyboard>) =>
    k?.inline_keyboard.flat().map((b) => b.callback_data);

  it("pending has ok/no/cx", () => {
    expect(cbs(entryKeyboard(entry()))).toEqual(["ok:7", "no:7", "cx:7"]);
  });
  it("approved has cx; confirmCancel has cy/cn", () => {
    expect(cbs(entryKeyboard(entry({ status: "approved" })))).toEqual(["cx:7"]);
    expect(cbs(entryKeyboard(entry({ status: "approved" }), true))).toEqual(["cy:7", "cn:7"]);
  });
  it("settled entries have none", () => {
    expect(entryKeyboard(entry({ status: "rejected" }))).toBeNull();
  });
  it("settlement and edit keyboards", () => {
    expect(settlementKeyboard(5).inline_keyboard.flat().map((b) => b.callback_data)).toEqual(["ok:5", "no:5"]);
    expect(editKeyboard(9).inline_keyboard.flat().map((b) => b.callback_data)).toEqual(["ea:9", "ed:9"]);
  });
});

describe("renderReminder / renderBalance", () => {
  const acc = summarize([trade()]); // client owes 1000 USDT, we owe 266,000,000 toman

  it("lists both what the client owes and what we owe", () => {
    const out = renderReminder("گروه", acc, [], "یادآوری");
    expect(out).toContain("۱٬۰۰۰");
    expect(out).toContain("تتر");
    expect(out).toContain("۲۶۶٬۰۰۰٬۰۰۰");
    expect(out).toContain("تومان");
    expect(out).toContain("ما هم");
  });

  it("omits the we-owe line when we owe nothing", () => {
    const only = summarize([trade({ rate: null })]);
    expect(renderReminder("گروه", only, [], "یادآوری")).not.toContain("ما هم");
  });

  it("says settled for a fully settled account", () => {
    const settled = summarize([trade(), trade({ side: "RECEIVE", rate: null, asset: "USDT" }), trade({ side: "PAY", rate: null, asset: "IRT", amount: D(266000000) })]);
    expect(renderBalance("گروه", settled, [])).toContain("تسویه");
  });
});

describe("jokes", () => {
  it("has enough lines and picks deterministically", () => {
    for (const l of [ORDINARY_LINES, NUDGE_LINES, CLIENT_WRITE_REFUSALS]) expect(l.length).toBeGreaterThanOrEqual(8);
    expect(pick(ORDINARY_LINES, 13)).toBe(ORDINARY_LINES[13 % ORDINARY_LINES.length]);
  });
});

describe("telegram client", () => {
  it("parses TgError from an ok:false response", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: group chat was upgraded to a supergroup chat",
          parameters: { migrate_to_chat_id: -100123 },
        }),
      )) as unknown as typeof fetch;
    const err = await createTg("T", f).call("sendMessage", {}).catch((e) => e);
    expect(err).toBeInstanceOf(TgError);
    expect(err.code).toBe(400);
    expect(err.migrateTo).toBe(-100123);
  });

  it("isForbidden covers 403 and chat not found", () => {
    expect(isForbidden(new TgError(403, "Forbidden: bot was blocked"))).toBe(true);
    expect(isForbidden(new TgError(400, "Bad Request: chat not found"))).toBe(true);
    expect(isForbidden(new TgError(400, "other"))).toBe(false);
  });

  it("returns result on success and posts to the bot URL", async () => {
    let url = "";
    const f = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }));
    }) as unknown as typeof fetch;
    expect(await createTg("TOK", f).call("sendMessage", { chat_id: 1 })).toEqual({ message_id: 3 });
    expect(url).toBe("https://api.telegram.org/botTOK/sendMessage");
  });
});

describe("FakeTg", () => {
  it("records calls, numbers messages, scripts replies and failures", async () => {
    const tg = new FakeTg();
    expect(await tg.call("sendMessage", { chat_id: 1 })).toEqual({ message_id: 1 });
    expect(await tg.call("sendMessage", { chat_id: 1 })).toEqual({ message_id: 2 });
    tg.reply("getMe", () => ({ id: 5 }));
    expect(await tg.call("getMe", {})).toEqual({ id: 5 });
    tg.fail("sendMessage", 9, new TgError(403, "blocked"));
    await expect(tg.call("sendMessage", { chat_id: 9 })).rejects.toBeInstanceOf(TgError);
    expect(tg.calls).toHaveLength(4);
  });
});
