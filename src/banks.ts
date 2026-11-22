/** Our own bank accounts: matching a spoken bank name to a stored one. Pure; no D1. */
import { normalize } from "./money";

export interface BankRef {
  id: number;
  name: string;
}

/** Comparison key: digits and letters normalised, «بانک» / «حساب» dropped, no spaces. */
export function bankKey(s: string): string {
  return normalize(s)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join("");
}
const FILLER: ReadonlySet<string> = new Set(["بانک", "حساب", "bank"]);
const LEAD: ReadonlySet<string> = new Set(["به", "از", "تو", "توی", "در", "to", "from"]);

/** The one bank a spoken name means: an exact key match, else the only partial match; null if none or several. */
export function matchBank<B extends BankRef>(banks: readonly B[], hint: string): B | null {
  const k = bankKey(hint);
  if (!k) return null;
  const exact = banks.filter((b) => bankKey(b.name) === k);
  if (exact.length === 1) return exact[0];
  const partial = banks.filter((b) => {
    const bk = bankKey(b.name);
    return bk !== "" && (bk.includes(k) || k.includes(bk));
  });
  return partial.length === 1 ? partial[0] : null;
}

/**
 * A `#` payment's note that starts with a bank («سامان», «به حساب سامان بابت فلان»): the bank and
 * the rest of the note. null when the note doesn't start with a known bank.
 */
export function splitBankNote<B extends BankRef>(banks: readonly B[], note: string): { bank: B; note: string } | null {
  const raw = note.trim().split(/\s+/).filter(Boolean);
  let start = 0;
  while (start < raw.length && LEAD.has(normalize(raw[start]).toLowerCase())) start++;
  const words = raw.slice(start);
  for (let n = words.length; n >= 1; n--) {
    const k = bankKey(words.slice(0, n).join(" "));
    if (!k) continue;
    const bank = banks.find((b) => bankKey(b.name) === k);
    if (bank) return { bank, note: words.slice(n).join(" ") };
  }
  return null;
}
