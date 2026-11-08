interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GEMINI_MODEL: string;
  DEFAULT_ASSET: string;
  BOT_TOKEN: string;
  GEMINI_API_KEY: string;
  WEBHOOK_SECRET: string;
  ADMIN_IDS?: string; // unset until the owner knows their id (/id still works)
}

declare namespace Cloudflare {
  interface Env extends globalThis.Env {
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
