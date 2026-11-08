/** Max chats handled per cron invocation (keeps subrequests under the Workers limit). Shared by reminders and broadcast. */
export const BATCH_SIZE = 40;

/** Telegram calls plus D1 statements one invocation may make (Workers Free allows ~50 of each kind of subrequest/query). */
export const INVOCATION_BUDGET = 45;

/** Per-invocation allowance, shared by every cron job; each Telegram call and each D1 statement costs 1. */
export class Budget {
  left: number;
  constructor(n: number = INVOCATION_BUDGET) {
    this.left = n;
  }
  take(n = 1): boolean {
    if (this.left < n) return false;
    this.left -= n;
    return true;
  }
}
