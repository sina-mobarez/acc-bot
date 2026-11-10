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

import { env } from "cloudflare:workers";
import type { App } from "../src/app";
import type { Nlu, NluInput, NluOutput } from "../src/nlu";
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

/** Scripted NLU: returns queued outputs in order (null once exhausted) and records inputs. */
export class FakeNlu implements Nlu {
  inputs: NluInput[] = [];
  private script: (NluOutput | null)[];
  constructor(...script: (NluOutput | null)[]) {
    this.script = script;
  }
  async understand(i: NluInput): Promise<NluOutput | null> {
    this.inputs.push(i);
    return this.script.length > 0 ? this.script.shift()! : null;
  }
}

export interface TestApp extends App {
  tg: FakeTg;
  nlu: FakeNlu;
  /** Await every promise passed to `defer` (including ones deferred while flushing). */
  flush(): Promise<void>;
}

export const FIXED_NOW = "2026-11-08T12:00:00+03:30";

export function makeApp(overrides: Partial<App> = {}): TestApp {
  const pending: Promise<unknown>[] = [];
  return {
    env,
    db: env.DB,
    tg: new FakeTg(),
    nlu: new FakeNlu(),
    fetch: fakeFetch({}),
    now: () => FIXED_NOW,
    adminIds: new Set([1]),
    defer: (p) => {
      pending.push(p);
    },
    flush: async () => {
      while (pending.length > 0) await Promise.allSettled(pending.splice(0));
    },
    ...overrides,
  } as TestApp;
}

/**
 * Fake fetch for one JSON-RPC endpoint (accepts single or batch requests): `handler(method, params)`
 * returns the `result`; throwing makes the whole request fail like a network error. Records calls.
 */
export function jsonRpcFetch(
  handler: (method: string, params: unknown[]) => unknown,
  calls: { url: string; body: unknown }[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ url, body });
    const one = (r: { id: unknown; method: string; params?: unknown[] }) => ({
      jsonrpc: "2.0",
      id: r.id,
      result: handler(r.method, r.params ?? []),
    });
    const out = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
