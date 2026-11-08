/** Minimal Telegram Bot API client (fetch-based, Workers-friendly). */

export interface Tg {
  call<T = any>(method: string, params: Record<string, unknown>): Promise<T>;
}

export class TgError extends Error {
  code: number;
  retryAfter?: number;
  migrateTo?: number;
  constructor(code: number, description: string, parameters?: { retry_after?: number; migrate_to_chat_id?: number }) {
    super(description);
    this.name = "TgError";
    this.code = code;
    this.retryAfter = parameters?.retry_after;
    this.migrateTo = parameters?.migrate_to_chat_id;
  }
}

export function createTg(token: string, f: typeof fetch): Tg {
  return {
    async call<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
      const res = await f(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      let body: any;
      try {
        body = await res.json();
      } catch {
        throw new TgError(res.status, `bad response (${res.status})`);
      }
      if (!body?.ok) {
        throw new TgError(body?.error_code ?? res.status, body?.description ?? "unknown error", body?.parameters);
      }
      return body.result as T;
    },
  };
}

/** The bot can no longer reach this chat (blocked, kicked, or gone). */
export const isForbidden = (e: unknown): boolean =>
  e instanceof TgError && (e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message)));

/** editMessage* with identical content. */
export const isNotModified = (e: unknown): boolean =>
  e instanceof TgError && /message is not modified/i.test(e.message);
