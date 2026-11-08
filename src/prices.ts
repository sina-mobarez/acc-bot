import Decimal from "decimal.js";
import "./money"; // configures Decimal precision

export type UsdtPrice = { latest: Decimal; bestBuy: Decimal; bestSell: Decimal };
export type CoinQuote = { coin: string; usdt: Decimal | null; toman: Decimal | null };

const NOBITEX_URL = "https://apiv2.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls";
const KUCOIN_URL = "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=";
const TIMEOUT_MS = 5000;

async function getJson(f: typeof fetch, url: string): Promise<any | null> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 200) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function toDecimal(v: unknown): Decimal | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** Nobitex USDT price in toman (the API returns rials; divide by 10). */
export async function fetchUsdtToman(f: typeof fetch): Promise<UsdtPrice | null> {
  const body = await getJson(f, NOBITEX_URL);
  if (!body || body.status !== "ok") return null;
  const s = body.stats?.["usdt-rls"];
  const latest = toDecimal(s?.latest);
  const bestBuy = toDecimal(s?.bestBuy);
  const bestSell = toDecimal(s?.bestSell);
  if (!latest || !bestBuy || !bestSell) return null;
  return { latest: latest.div(10), bestBuy: bestBuy.div(10), bestSell: bestSell.div(10) };
}

/** KuCoin `<COIN>-USDT` last price. `data` is null for an unknown symbol. */
export async function fetchCoinUsdt(coin: string, f: typeof fetch): Promise<Decimal | null> {
  const body = await getJson(f, KUCOIN_URL + encodeURIComponent(coin.toUpperCase()) + "-USDT");
  if (!body || body.code !== "200000") return null;
  const price = toDecimal(body.data?.price);
  return price && price.gt(0) ? price : null;
}

export async function quoteCoins(coins: string[], f: typeof fetch): Promise<CoinQuote[]> {
  const upper = coins.map((c) => c.toUpperCase());
  const [rate, usdts] = await Promise.all([
    fetchUsdtToman(f),
    Promise.all(upper.map((c) => (c === "USDT" ? Promise.resolve(new Decimal(1)) : fetchCoinUsdt(c, f)))),
  ]);
  return upper.map((coin, i) => {
    const usdt = usdts[i];
    return { coin, usdt, toman: usdt && rate ? usdt.mul(rate.latest) : null };
  });
}
