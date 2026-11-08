import type { Nlu } from "./nlu";
import type { Tg } from "./telegram";

/** The dependency bag every handler takes. */
export interface App {
  env: Env;
  db: D1Database;
  tg: Tg;
  nlu: Nlu;
  fetch: typeof fetch; // for prices
  now(): string; // ISO, +03:30
  adminIds: Set<number>;
  defer(p: Promise<unknown>): void; // ctx.waitUntil in prod; collects promises in tests
}

const TEHRAN_OFFSET_MS = 3.5 * 3600_000;

/** Current time as '2026-10-17T19:05:00+03:30'. */
export function nowTehran(): string {
  return new Date(Date.now() + TEHRAN_OFFSET_MS).toISOString().replace(/\.\d+Z$/, "+03:30");
}
