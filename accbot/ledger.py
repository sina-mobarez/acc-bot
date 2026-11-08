"""Per-client account from approved trades and payments: who owes whom.

Everything is from our side. For each asset, `owed` > 0 means the client owes
us, < 0 means we owe the client:

    BUY  a @ r   client owes us a (asset)    we owe a×r toman
    SELL a @ r   we owe a (asset)            client owes us a×r toman
    PAY  x       we paid x       -> +x
    RECEIVE x    client paid x   -> -x
"""

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal

from .parser import TOMAN, Trade


@dataclass
class AssetBalance:
    """Trading stats for one asset."""

    asset: str
    bought: Decimal = Decimal(0)
    sold: Decimal = Decimal(0)
    buy_toman: Decimal = Decimal(0)  # toman value of priced buys
    sell_toman: Decimal = Decimal(0)  # toman value of priced sells
    priced_bought: Decimal = Decimal(0)
    priced_sold: Decimal = Decimal(0)
    count: int = 0
    unpriced: int = 0

    @property
    def avg_buy(self) -> Decimal | None:
        return self.buy_toman / self.priced_bought if self.priced_bought else None

    @property
    def avg_sell(self) -> Decimal | None:
        return self.sell_toman / self.priced_sold if self.priced_sold else None


@dataclass
class Account:
    owed: dict[str, Decimal] = field(default_factory=lambda: defaultdict(Decimal))
    trades: list[AssetBalance] = field(default_factory=list)
    paid: dict[str, Decimal] = field(default_factory=lambda: defaultdict(Decimal))
    received: dict[str, Decimal] = field(default_factory=lambda: defaultdict(Decimal))
    unpriced: int = 0
    count: int = 0

    def debts(self) -> list[tuple[str, Decimal]]:
        """(asset, owed) for every asset that has been touched, USDT then toman first."""
        order = {"USDT": 0, TOMAN: 1}
        return sorted(self.owed.items(), key=lambda kv: (order.get(kv[0], 2), kv[0]))


def _key(asset: str) -> tuple:
    return (asset != "USDT", asset)


def summarize(entries: list[Trade]) -> Account:
    acc = Account()
    stats: dict[str, AssetBalance] = {}
    for t in entries:
        acc.count += 1
        if t.is_payment:
            if t.side == "PAY":
                acc.paid[t.asset] += t.amount
                acc.owed[t.asset] += t.amount
            else:
                acc.received[t.asset] += t.amount
                acc.owed[t.asset] -= t.amount
            continue

        b = stats.setdefault(t.asset, AssetBalance(t.asset))
        b.count += 1
        sign = 1 if t.side == "BUY" else -1
        acc.owed[t.asset] += sign * t.amount
        if t.side == "BUY":
            b.bought += t.amount
        else:
            b.sold += t.amount
        if t.rate is None:
            b.unpriced += 1
            acc.unpriced += 1
            continue
        acc.owed[TOMAN] -= sign * t.total
        if t.side == "BUY":
            b.buy_toman += t.total
            b.priced_bought += t.amount
        else:
            b.sell_toman += t.total
            b.priced_sold += t.amount
    acc.trades = sorted(stats.values(), key=lambda b: _key(b.asset))
    return acc
