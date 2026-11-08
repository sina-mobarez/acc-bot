export type FakeRoutes = Record<string, unknown>;

/**
 * Fake `fetch` matched by request hostname. A number value responds with
 * that status (empty body); anything else is returned as a JSON body (200).
 * Unrouted hosts throw, like a network failure.
 */
export function fakeFetch(routes: FakeRoutes): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!(url.hostname in routes)) throw new Error(`fakeFetch: no route for ${url.hostname}`);
    const r = routes[url.hostname];
    if (typeof r === "number") return new Response(null, { status: r });
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

import type { Tg } from "../src/telegram";

/** Scriptable Telegram: records calls, default result `{ message_id: n++ }`. */
export class FakeTg implements Tg {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  private handlers = new Map<string, (params: Record<string, any>) => unknown>();
  private failures: { method: string; chatId: unknown; err: Error }[] = [];
  private nextId = 1;

  reply(method: string, fn: (params: Record<string, any>) => unknown): void {
    this.handlers.set(method, fn);
  }

  /** Make `method` throw `err` for calls addressed to `chatId`. */
  fail(method: string, chatId: unknown, err: Error): void {
    this.failures.push({ method, chatId, err });
  }

  async call<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const failure = this.failures.find((x) => x.method === method && x.chatId === params.chat_id);
    if (failure) throw failure.err;
    const h = this.handlers.get(method);
    if (h) return (await h(params)) as T;
    return { message_id: this.nextId++ } as T;
  }
}
