import { describe, expect, test } from "vitest";
import { createGeminiNlu, SYSTEM_PROMPT, type NluInput } from "../src/nlu";
import { fakeFetch } from "./fakes";

const input: NluInput = { text: "۱۰۰ تتر خریدم", role: "admin", chat: "group", openDeals: [] };
const HOST = "generativelanguage.googleapis.com";
const candidate = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const nlu = (routes: Record<string, unknown>) => createGeminiNlu("KEY", "gemini-flash-latest", fakeFetch(routes));

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
