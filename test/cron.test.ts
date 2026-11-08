import { env } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as broadcast from "../src/broadcast";
import { runCron } from "../src/cron";
import * as db from "../src/db";
import * as reminders from "../src/reminders";
import { makeApp } from "./fakes";

const AT = new Date("2026-11-08T08:00:00Z"); // 11:30 Tehran

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCron", () => {
  test("a failing step does not starve the others", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(reminders, "runReminders").mockRejectedValue(new Error("reminders boom"));
    const batch = vi.spyOn(broadcast, "runBroadcastBatch").mockRejectedValue(new Error("broadcast boom"));
    await env.DB.prepare("INSERT OR IGNORE INTO processed_updates (update_id, at) VALUES (?, ?)")
      .bind(424242, "2026-01-01T00:00:00+03:30")
      .run();
    await runCron(makeApp(), AT);
    expect(batch).toHaveBeenCalledTimes(1);
    const left = await env.DB.prepare("SELECT 1 FROM processed_updates WHERE update_id = 424242").first();
    expect(left).toBeNull(); // prune still ran
    expect(err).toHaveBeenCalledTimes(2);
  });

  test("a failing prune is logged, not thrown", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "pruneUpdates").mockRejectedValue(new Error("prune boom"));
    await expect(runCron(makeApp(), AT)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
  });
});
