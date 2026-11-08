/** Max chats handled per cron invocation (keeps subrequests under the Workers limit). Shared by reminders and broadcast. */
export const BATCH_SIZE = 40;
