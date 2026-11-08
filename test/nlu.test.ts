import { describe, expect, test } from "vitest";
import { clampNluOutput, createGeminiNlu, SYSTEM_PROMPT, type NluInput } from "../src/nlu";
import { fakeFetch } from "./fakes";

const input: NluInput = { text: "۱۰۰ تتر خریدم", role: "admin", chat: "group", openDeals: [] };
const HOST = "generativelanguage.googleapis.com";
const candidate = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const nlu = (routes: Record<string, unknown>) => createGeminiNlu("KEY", "gemini-3.5-flash-lite", fakeFetch(routes));

describe("gemini nlu", () => {
  test("valid candidate -> parsed output (nulls dropped)", async () => {
    const out = await nlu({
      [HOST]: candidate(JSON.stringify({ intent: "create_trade", side: "BUY", amount_text: "۱۰۰", joke: null })),
    }).understand(input);
    expect(out).toEqual({ intent: "create_trade", side: "BUY", amount_text: "۱۰۰" });
  });

  test("429 -> null", async () => {
    expect(await nlu({ [HOST]: 429 }).understand(input)).toBeNull();
  });

  test("non-JSON text -> null", async () => {
    expect(await nlu({ [HOST]: candidate("not json") }).understand(input)).toBeNull();
  });

  test("missing intent / bad enum / wrong type -> null", async () => {
    for (const bad of [{ side: "BUY" }, { intent: "rob_bank" }, { intent: "chitchat", reply: 5 }]) {
      expect(await nlu({ [HOST]: candidate(JSON.stringify(bad)) }).understand(input)).toBeNull();
    }
  });

  test("no candidates / network error -> null", async () => {
    expect(await nlu({ [HOST]: { candidates: [] } }).understand(input)).toBeNull();
    expect(await nlu({}).understand(input)).toBeNull();
  });

  test("long Gemini text is truncated before it reaches Telegram", async () => {
    const long = "ا".repeat(5000);
    const out = await nlu({
      [HOST]: candidate(JSON.stringify({ intent: "chitchat", reply: long, joke: long, note: long, changes: { note: long } })),
    }).understand(input);
    expect(out!.reply!.length).toBeLessThanOrEqual(1000);
    expect(out!.joke!.length).toBeLessThanOrEqual(200);
    expect(out!.note!.length).toBeLessThanOrEqual(200);
    expect(out!.changes!.note!.length).toBeLessThanOrEqual(200);
    expect(clampNluOutput({ intent: "chitchat", reply: "کوتاه" })).toEqual({ intent: "chitchat", reply: "کوتاه" });
  });

  test("system prompt keeps the money-facts, hard-line and verbatim-number rules", () => {
    expect(SYSTEM_PROMPT).toContain("never state balances, amounts, debts or prices in reply or joke");
    expect(SYSTEM_PROMPT).toContain("query_balance, query_deals or query_price");
    expect(SYSTEM_PROMPT).toContain("never insult family, religion, ethnicity or physical appearance");
    expect(SYSTEM_PROMPT).toContain("Nothing sexual");
    expect(SYSTEM_PROMPT).toContain("Copy numbers VERBATIM");
    expect(SYSTEM_PROMPT).toContain("NEVER compute, convert, round, expand or guess a number");
  });

  test("request carries schema, key header and input", async () => {
    let seen: { url: string; headers: Headers; body: any } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify(candidate(JSON.stringify({ intent: "chitchat" }))));
    }) as unknown as typeof fetch;
    await createGeminiNlu("KEY", "m1", f).understand(input);
    expect(seen!.url).toBe(`https://${HOST}/v1beta/models/m1:generateContent`);
    expect(seen!.headers.get("x-goog-api-key")).toBe("KEY");
    expect(seen!.body.generationConfig.responseSchema).toBeDefined();
    expect(seen!.body.generationConfig.responseMimeType).toBe("application/json");
    expect(seen!.body.systemInstruction.parts[0].text).toBe(SYSTEM_PROMPT);
    expect(seen!.body.contents[0].parts[0].text).toContain("۱۰۰ تتر خریدم");
  });
});
