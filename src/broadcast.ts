import type { Message } from "@grammyjs/types";
import type { App } from "./app";

/** Task 12: capture the message an admin wants to broadcast. */
export async function onBroadcastCapture(_app: App, _msg: Message): Promise<void> {}

/** Task 12: /broadcast (private chat, admins). */
export async function onBroadcastCommand(_app: App, _msg: Message): Promise<void> {}

/** Task 12: /groups (private chat, admins). */
export async function onGroupsCommand(_app: App, _msg: Message): Promise<void> {}

/** Task 12: /cancel of a pending broadcast (private chat, admins). */
export async function onCancelCommand(_app: App, _msg: Message): Promise<void> {}
