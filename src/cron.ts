import type { App } from "./app";
import { runBroadcastBatch } from "./broadcast";
import { pruneUpdates } from "./db";
import { runReminders } from "./reminders";

import { Budget } from "./constants";

export { BATCH_SIZE } from "./constants";

const PRUNE_AFTER_MS = 2 * 86_400_000;
const TEHRAN_OFFSET_MS = 3.5 * 3600_000;

/** Run one cron step; a failure is logged so the remaining steps still get their turn. */
async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.error(`cron step ${name} failed`, e);
  }
}

/** Every-minute tick: reminders, then a broadcast batch, then housekeeping. Each step is isolated. */
export async function runCron(app: App, at: Date): Promise<void> {
  const budget = new Budget();
  budget.take(); // reserved for the prune below
  await step("reminders", () => runReminders(app, at, budget));
  await step("broadcast", () => runBroadcastBatch(app, budget));
  // processed_updates.at holds nowTehran() strings ('...+03:30'), so compare in the same form.
  const cutoff = new Date(at.getTime() - PRUNE_AFTER_MS + TEHRAN_OFFSET_MS)
    .toISOString()
    .replace(/\.\d+Z$/, "+03:30");
  await step("prune", () => pruneUpdates(app.db, cutoff));
}
