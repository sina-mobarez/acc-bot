/**
 * Per-client account from approved trades and payments: who owes whom.
 *
 * Everything is from our side. For each asset, `owed` > 0 means the client owes
 * us, < 0 means we owe the client:
 *
 *   BUY  a @ r   client owes us a (asset)    we owe a x r toman
 *   SELL a @ r   we owe a (asset)            client owes us a x r toman
 *   PAY  x       we paid x       -> +x
 *   RECEIVE x    client paid x   -> -x
 */
import Decimal from "decimal.js";
import { TOMAN } from "./money"; // also applies the global decimal.js config
import { isPayment, type Trade, tradeTotal } from "./trade";

const ZERO = new Decimal(0);

/** Trading stats for one asset. */
export class AssetStats {
  bought = ZERO;
  sold = ZERO;
  buyToman = ZERO; // toman value of priced buys
  sellToman = ZERO; // toman value of priced sells
  pricedBought = ZERO;
  pricedSold = ZERO;
  count = 0;
  unpriced = 0;

  constructor(readonly asset: string) {}

  get avgBuy(): Decimal | null {
    return this.pricedBought.isZero() ? null : this.buyToman.div(this.pricedBought);
  }

  get avgSell(): Decimal | null {
    return this.pricedSold.isZero() ? null : this.sellToman.div(this.pricedSold);
  }
}

export interface Account {
  owed: Map<string, Decimal>;
  trades: AssetStats[];
  paid: Map<string, Decimal>;
  received: Map<string, Decimal>;
  unpriced: number;
  count: number;
}

function add(m: Map<string, Decimal>, key: string, v: Decimal): void {
  m.set(key, (m.get(key) ?? ZERO).plus(v));
}

const rank = (asset: string): number => (asset === "USDT" ? 0 : asset === TOMAN ? 1 : 2);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** (asset, owed) for every asset that has been touched, USDT then toman first. */
export function debts(acc: Account): [string, Decimal][] {
  return [...acc.owed.entries()].sort(([a], [b]) => rank(a) - rank(b) || byName(a, b));
}

export function summarize(entries: Trade[]): Account {
  const acc: Account = {
    owed: new Map(),
    trades: [],
    paid: new Map(),
    received: new Map(),
    unpriced: 0,
    count: 0,
  };
  const stats = new Map<string, AssetStats>();
  for (const t of entries) {
    acc.count++;
    if (isPayment(t)) {
      if (t.side === "PAY") {
        add(acc.paid, t.asset, t.amount);
        add(acc.owed, t.asset, t.amount);
      } else {
        add(acc.received, t.asset, t.amount);
        add(acc.owed, t.asset, t.amount.neg());
      }
      continue;
    }

    let b = stats.get(t.asset);
    if (!b) stats.set(t.asset, (b = new AssetStats(t.asset)));
    b.count++;
    const buy = t.side === "BUY";
    add(acc.owed, t.asset, buy ? t.amount : t.amount.neg());
    if (buy) b.bought = b.bought.plus(t.amount);
    else b.sold = b.sold.plus(t.amount);
    const total = tradeTotal(t);
    if (t.rate === null || total === null) {
      b.unpriced++;
      acc.unpriced++;
      continue;
    }
    add(acc.owed, TOMAN, buy ? total.neg() : total);
    if (buy) {
      b.buyToman = b.buyToman.plus(total);
      b.pricedBought = b.pricedBought.plus(t.amount);
    } else {
      b.sellToman = b.sellToman.plus(total);
      b.pricedSold = b.pricedSold.plus(t.amount);
    }
  }
  acc.trades = [...stats.values()].sort(
    (a, b) => Number(a.asset !== "USDT") - Number(b.asset !== "USDT") || byName(a.asset, b.asset),
  );
  return acc;
}

export interface LedgerEntry {
  id: number;
  trade: Trade;
  linkedDealId: number | null;
}

export interface Leg {
  asset: string;
  dir: "client_owes" | "we_owe";
  total: Decimal;
  remaining: Decimal;
}

/** Per trade id, its legs after payments (linked deal first, then FIFO). */
export function allocate(entries: LedgerEntry[]): Map<number, Leg[]> {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const legsById = new Map<number, Leg[]>();
  const order: Leg[] = []; // every leg, oldest deal first
  const leg = (asset: string, dir: Leg["dir"], total: Decimal): Leg => ({
    asset,
    dir,
    total,
    remaining: total,
  });

  for (const { id, trade: t } of sorted) {
    if (isPayment(t)) continue;
    const buy = t.side === "BUY";
    const legs = [leg(t.asset, buy ? "client_owes" : "we_owe", t.amount)];
    const total = tradeTotal(t);
    if (total !== null) legs.push(leg(TOMAN, buy ? "we_owe" : "client_owes", total));
    legsById.set(id, legs);
    order.push(...legs);
  }

  for (const { trade: t, linkedDealId } of sorted) {
    if (!isPayment(t)) continue;
    const dir: Leg["dir"] = t.side === "RECEIVE" ? "client_owes" : "we_owe";
    const matches = (l: Leg) => l.asset === t.asset && l.dir === dir;
    let x = t.amount;
    const take = (l: Leg) => {
      const taken = Decimal.min(x, l.remaining);
      l.remaining = l.remaining.minus(taken);
      x = x.minus(taken);
    };
    if (linkedDealId !== null) {
      const target = legsById.get(linkedDealId)?.find(matches);
      if (target) take(target);
    }
    for (const l of order) {
      if (x.lte(0)) break;
      if (matches(l) && l.remaining.gt(0)) take(l);
    }
  }
  return legsById;
}

/** Open trades (any leg with remaining > 0), oldest first. */
export function openDeals(entries: LedgerEntry[]): { id: number; legs: Leg[] }[] {
  return [...allocate(entries).entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, legs]) => ({ id, legs }))
    .filter((d) => d.legs.some((l) => l.remaining.gt(0)));
}
