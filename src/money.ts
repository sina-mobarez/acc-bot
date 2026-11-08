import Decimal from "decimal.js";

// v1 used 28 digits; 40 keeps every product/quotient exact enough. Configured once for all modules.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

// Persian/Arabic digits and separators -> ASCII; Arabic yeh/kaf -> Persian.
const FROM = "۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩٬٫يك";
const TO = "01234567890123456789,.یک";
const NORMALIZE = new Map<string, string>([...FROM].map((c, i) => [c, [...TO][i]]));

export function normalize(s: string): string {
  let out = "";
  for (const c of s ?? "") out += c === "‌" ? " " : (NORMALIZE.get(c) ?? c);
  return out;
}

const d = (n: number) => new Decimal(n);
export const MULTIPLIERS: Record<string, Decimal> = {
  k: d(1_000), "هزار": d(1_000),
  m: d(1_000_000), mm: d(1_000_000), mil: d(1_000_000),
  mln: d(1_000_000), milion: d(1_000_000), million: d(1_000_000),
  "میلیون": d(1_000_000), "ملیون": d(1_000_000),
  b: d(1_000_000_000), bn: d(1_000_000_000), billion: d(1_000_000_000),
  "میلیارد": d(1_000_000_000), "ملیارد": d(1_000_000_000),
};

// Persian asset names -> code. Latin names are just upper-cased.
export const ASSETS: Record<string, string> = {
  "تتر": "USDT", "دلار": "USD", "یورو": "EUR", "درهم": "AED", "لیر": "TRY",
  "تومن": "IRT", "تومان": "IRT", toman: "IRT",
};
export const ASSET_NAMES: Record<string, string> = {
  USDT: "تتر", USD: "دلار", EUR: "یورو", AED: "درهم", TRY: "لیر", IRT: "تومان",
};
export const TOMAN = "IRT";
// Decimal places kept when a toman amount is converted to units of the asset.
export const PRECISION: Record<string, number> = { USDT: 2, USD: 2, EUR: 2, AED: 2, TRY: 2 };

export function assetCode(word: string): string {
  return Object.hasOwn(ASSETS, word) ? ASSETS[word] : word.toUpperCase();
}

export function assetName(code: string): string {
  return Object.hasOwn(ASSET_NAMES, code) ? ASSET_NAMES[code] : code;
}

// JS \b doesn't work for Persian letters; this is a Unicode-aware word end.
export const WORD_END = "(?![\\p{L}\\p{N}_])";
export const NUM = "\\d[\\d,]*(?:\\.\\d+)?";
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longer spellings first so "million" isn't consumed as "m".
export const MULT = Object.keys(MULTIPLIERS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRe)
  .join("|");

export function applyMult(text: string, mult?: string): Decimal {
  const value = new Decimal(text.replace(/,/g, ""));
  return mult ? value.mul(MULTIPLIERS[mult.toLowerCase()]) : value;
}

const AMOUNT_RE = new RegExp(`^(${NUM})\\s*(?:(${MULT})${WORD_END})?(?:\\s+(.+))?$`, "iu");

// Words an LLM copies along with an amount ("۱۰۰ تا تتر", "۲۷۶ هزار تومن"); ignored, the unit comes from amount_unit.
const UNIT_WORDS: ReadonlySet<string> = new Set([
  "تا", "عدد",
  ...Object.keys(ASSETS).map((k) => k.toLowerCase()),
  ...Object.keys(ASSET_NAMES).map((k) => k.toLowerCase()),
  "usdt", "usd", "eur", "aed", "try", "irt",
]);

/** "۲ میلیون" -> 2000000, "275k" -> 275000, "2,500,000" -> 2500000; null if not an amount. */
export function parseAmountText(s: string): Decimal | null {
  const m = AMOUNT_RE.exec(normalize(s).trim());
  if (!m) return null;
  if (m[3] && !m[3].trim().split(/\s+/).every((w) => UNIT_WORDS.has(w.toLowerCase()))) return null;
  try {
    return applyMult(m[1], m[2]);
  } catch {
    return null;
  }
}

/** 1234567.5 -> "1,234,567.5"; drops trailing zeros. */
export function fmtNum(v: Decimal): string {
  let s = v.toFixed();
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  const neg = s.startsWith("-");
  const [int, frac] = (neg ? s.slice(1) : s).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac ? "." + frac : "");
}

const TO_FA = "۰۱۲۳۴۵۶۷۸۹";
/** Format a number (or any string) with Persian digits. */
export function fa(v: Decimal | number | string): string {
  const s = v instanceof Decimal ? fmtNum(v) : String(v);
  return s.replace(/[0-9,.]/g, (c) => (c === "," ? "٬" : c === "." ? "٫" : TO_FA[Number(c)]));
}
