/** The «پنل مدیریت» menu button: shown only in admins' private chats (R24); everyone else keeps the commands menu. */
import type { App } from "../app";
import { getSetting } from "../db";

export const MENU_TEXT = "پنل مدیریت";

/** Best-effort: give one admin's private chat the Mini App button. False if it could not be set. */
export async function setAdminMenuButton(app: App, userId: number, origin?: string): Promise<boolean> {
  const base = origin ?? (await getSetting(app.db, "public_url"));
  if (!base) return false;
  try {
    await app.tg.call("setChatMenuButton", {
      chat_id: userId,
      menu_button: { type: "web_app", text: MENU_TEXT, web_app: { url: `${base}/app/` } },
    });
    return true;
  } catch (e) {
    console.error("setChatMenuButton failed", userId, e);
    return false;
  }
}
