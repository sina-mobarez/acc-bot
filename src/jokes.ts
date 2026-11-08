/** Fixed Persian joke lines. Light, friendly teasing only: no family, religion, ethnicity, looks or sexual content. */
import type Decimal from "decimal.js";
import { fa } from "./money";

export const ORDINARY_LINES: string[] = [
  "حساب حساب است، داداش! 😄",
  "دفتر که باز شد، همه چیز رسمی می‌شود 📒",
  "ثبت شد؛ حالا دیگر نمی‌شود گفت «یادم نیست» 😉",
  "این عدد را گذاشتم تو دفتر، جایش امن است 🔐",
  "بازار گرم است، دفتر گرم‌تر 🔥",
  "ماشین‌حساب من خسته نمی‌شود، ولی حساب را هم گذر نمی‌دهد 🧮",
  "یک معامله‌ی دیگر، یک خط دیگر تو دفتر ✍️",
  "تومان می‌آید و می‌رود، دفتر می‌ماند 😎",
  "چک‌وچانه تمام شد، حالا نوبت تایید است 🤝",
  "دلار که بالا و پایین می‌شود، دفتر ما ثابت است 📈",
];

export const NUDGE_LINES: string[] = [
  "یک یادآوری دوستانه از دفتر: حساب منتظر شماست 😄",
  "دفتر می‌گوید دلش برای تسویه تنگ شده 📒",
  "حساب که دیر بماند، دلتنگ‌تر می‌شود ها 😉",
  "فقط یادآوری؛ دفتر که فراموش نمی‌کند 🧠",
  "یک سر به حساب بزنید، حالش بد نیست ولی بهتر هم می‌شود 🙂",
  "تسویه کنیم که دفتر راحت بخوابد 😴",
  "ما که پایه‌ایم، شما چطور؟ یک نگاه به حساب بیندازید 🤝",
  "گفتیم یادآوری کنیم، خدای نکرده گله نیست 🌹",
];

export const CLIENT_WRITE_REFUSALS: string[] = [
  "ثبت معامله کار ادمین‌هاست، دفتر فقط دست آن‌ها امضا می‌شود 😄",
  "قلم دفتر دست ادمین است، شما فقط تماشا کنید 🖋️",
  "این‌جا فقط ادمین‌ها اجازه‌ی ثبت دارند؛ شما بپرسید، ما جواب می‌دهیم 🙂",
  "دفتر را فقط ادمین‌ها می‌نویسند، شما بخوانید و لذت ببرید 📒",
  "نه جانم، ثبت معامله مال ادمین‌هاست؛ تراز را می‌توانید ببینید 😉",
  "دستت درد نکند، ولی قلم دست ادمین است 🙏",
  "ثبت کار ادمین است، پرسیدن کار شما؛ تقسیم کار عادلانه 😎",
  "اجازه‌ی ثبت فقط با ادمین‌هاست، دفتر مقررات دارد 📜",
];

export const BUSY_TEXT =
  "الان سرم شلوغ است و نمی‌توانم متن را بفهمم 😅\nمعامله را با # بنویسید، مثلاً:\n<code>#خرید ۱۰۰۰ تتر ۲۶۴۰۰۰</code>";

/** Deterministic pick: lines[seed % length]. */
export function pick(lines: string[], seed: number): string {
  return lines[Math.abs(seed) % lines.length];
}

/** Teasing for a rate far from Nobitex (either direction). {ref} = Nobitex price, {rate} = the trade's rate, {dev} = deviation %. */
export const GOUGING_LINES: string[] = [
  "نوبیتکس داره {ref} می‌ده، تو داری {rate} حساب می‌کنی؟ خون ما رو تو شیشه کردی! 😄",
  "{rate}؟ بازار {ref} است داداش، این قیمت را از کدام کهکشان آوردی؟ 🚀",
  "نوبیتکس {ref}، شما {rate}؛ اختلاف {dev} درصد! دفتر دارد عرق می‌کند 😅",
  "با این نرخ {rate}، نوبیتکس هم که {ref} است دلش برای ما می‌سوزد 🥲",
  "قیمت {rate} را که دیدم، ماشین‌حساب دفتر یک آهی کشید؛ بازار که {ref} است 🧮",
  "حاجی، {ref} بازار است نه {rate}! حساب کتاب با شوخی راه می‌افتد ولی نه این‌قدر 😉",
  "دفتر ثبتش کرد، ولی با اخم: نوبیتکس {ref} و این معامله {rate}، یعنی چه؟ 🤨",
  "اگر قیمت‌ها را این‌طور بچینیم، نوبیتکس {ref} ما را تعطیل می‌کند؛ {rate} کمی عجیب است 😎",
];

/** Pick a GOUGING line and fill it in. ref/rate are toman per USDT. */
export function gougingLine(seed: number, ref: Decimal, rate: Decimal): string {
  const dev = rate.sub(ref).div(ref).mul(100).abs().toDecimalPlaces(1);
  return pick(GOUGING_LINES, seed)
    .replaceAll("{ref}", fa(ref))
    .replaceAll("{rate}", fa(rate))
    .replaceAll("{dev}", fa(dev));
}
