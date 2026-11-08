/** Telegram Mini App initData validation (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). */

const enc = new TextEncoder();

async function hmacKey(key: ArrayBuffer | Uint8Array, usages: ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}

/**
 * The user behind a correctly signed, fresh initData string, or null.
 * secret = HMAC_SHA256(key "WebAppData", botToken); hash = HMAC_SHA256(secret, data_check_string).
 */
export async function validateInitData(
  initData: string,
  botToken: string,
  nowSec: number,
  maxAgeSec = 86400,
): Promise<{ id: number; name: string } | null> {
  if (!botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const given = hash ? fromHex(hash) : null;
  if (!given) return null;

  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = await crypto.subtle.sign("HMAC", await hmacKey(enc.encode("WebAppData"), ["sign"]), enc.encode(botToken));
  // verify() compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), given, enc.encode(dataCheck));
  if (!valid) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0 || nowSec - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "") as {
      id?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown;
    };
    if (typeof user.id !== "number" || !Number.isSafeInteger(user.id)) return null;
    const full = [user.first_name, user.last_name].filter((x) => typeof x === "string" && x).join(" ");
    const name = typeof user.username === "string" && user.username ? `@${user.username}` : full;
    return { id: user.id, name: name || String(user.id) };
  } catch {
    return null;
  }
}
