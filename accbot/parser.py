"""Parse trade and payment messages in Persian or English.

    #خرید ۱۰۰ تا تتر رو قیمت ۲۷۵۰۰۰ تومن
    #فروش ۲ میلیون تتر ۳۲۰۰۰۰ بانک ملت
    #buy 2 m usdt @ 275000 note
    #دریافت ۵۰ میلیون تومن کارت به کارت
    #پرداخت ۱۰۰ تتر

Every message must start with # so ordinary chat is never taken as a deal.

Everything is from our side: خرید/buy = we buy from the client,
پرداخت/pay = we pay the client, دریافت/receive = the client pays us.
"""

import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

# Persian/Arabic digits and separators -> ASCII; Arabic yeh/kaf -> Persian.
_NORMALIZE = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩٬٫يك", "01234567890123456789,.یک")

SIDES = {"buy": "BUY", "خرید": "BUY", "sell": "SELL", "فروش": "SELL"}
PAYMENT_SIDES = {
    "پرداخت": "PAY", "ارسال": "PAY", "pay": "PAY", "paid": "PAY",
    "دریافت": "RECEIVE", "receive": "RECEIVE", "received": "RECEIVE",
}

MULTIPLIERS = {
    "k": Decimal(1_000), "هزار": Decimal(1_000),
    "m": Decimal(1_000_000), "mm": Decimal(1_000_000), "mil": Decimal(1_000_000),
    "mln": Decimal(1_000_000), "milion": Decimal(1_000_000), "million": Decimal(1_000_000),
    "میلیون": Decimal(1_000_000), "ملیون": Decimal(1_000_000),
    "b": Decimal(1_000_000_000), "bn": Decimal(1_000_000_000), "billion": Decimal(1_000_000_000),
    "میلیارد": Decimal(1_000_000_000), "ملیارد": Decimal(1_000_000_000),
}

# Persian asset names -> code. Latin names are just upper-cased.
ASSETS = {"تتر": "USDT", "دلار": "USD", "یورو": "EUR", "درهم": "AED", "لیر": "TRY",
          "تومن": "IRT", "تومان": "IRT", "toman": "IRT"}
ASSET_NAMES = {"USDT": "تتر", "USD": "دلار", "EUR": "یورو", "AED": "درهم", "TRY": "لیر", "IRT": "تومان"}
TOMAN = "IRT"
# Decimal places kept when a toman amount is converted to units of the asset.
PRECISION = {"USDT": 2, "USD": 2, "EUR": 2, "AED": 2, "TRY": 2}

_NUM = r"\d[\d,]*(?:\.\d+)?"
# Longer spellings first so "million" isn't consumed as "m".
_MULT = "|".join(sorted(map(re.escape, MULTIPLIERS), key=len, reverse=True))
_COUNT_WORD = r"(?:تا|عدد)\b"
_RATE_KW = r"(?:@|(?:(?:رو|روی|به|با|در)\s+)?(?:قیمت|نرخ|فی)\b|at\b|rate\b)"
_CURRENCY = r"(?:تومن|تومان|toman)\b"
_HASHTAG = r"\#\s*"
# Payments only accept known asset names so a note like "بانک ملت" isn't taken as one.
_KNOWN_ASSET = "|".join(sorted(map(re.escape, [*ASSETS, *ASSET_NAMES]), key=len, reverse=True))

TRADE_RE = re.compile(
    rf"""^\s*{_HASHTAG}
    (?P<side>buy|sell|خرید|فروش)\s+
    (?P<amount>{_NUM})\s*
    (?:(?P<mult>{_MULT})\b)?\s*
    (?:(?P<toman>{_CURRENCY})\s*)?   # "۵۰۰ میلیون تومان تتر": the amount is in toman
    (?:{_COUNT_WORD}\s*)?
    (?:(?!{_COUNT_WORD}|{_RATE_KW}|{_CURRENCY})(?P<asset>[^\W\d_]{{2,15}}))?
    (?:\s*{_RATE_KW}?\s*(?P<rate>{_NUM})\s*(?:(?P<rmult>{_MULT})\b)?\s*(?:{_CURRENCY})?)?
    (?:\s+(?P<note>.+?))?
    \s*$""",
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)

PAYMENT_RE = re.compile(
    rf"""^\s*{_HASHTAG}
    (?P<side>{"|".join(PAYMENT_SIDES)})\s+
    (?P<amount>{_NUM})\s*
    (?:(?P<mult>{_MULT})\b)?\s*
    (?:(?P<asset>{_KNOWN_ASSET})\b)?
    (?:\s+(?P<note>.+?))?
    \s*$""",
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)


@dataclass(frozen=True)
class Trade:
    """A deal (BUY/SELL, priced in toman) or a payment (PAY/RECEIVE of any asset)."""

    side: str  # "BUY", "SELL", "PAY" or "RECEIVE"
    amount: Decimal
    asset: str
    rate: Decimal | None = None  # toman per unit; trades only
    note: str = ""
    toman_total: Decimal | None = None  # set when the trade was written as a toman amount

    @property
    def by_toman(self) -> bool:
        return self.toman_total is not None

    @property
    def is_payment(self) -> bool:
        return self.side in ("PAY", "RECEIVE")

    @property
    def total(self) -> Decimal | None:
        """Toman value: amount × rate for trades, the amount itself for toman payments."""
        if self.toman_total is not None:
            return self.toman_total
        if self.rate is not None:
            return self.amount * self.rate
        if self.is_payment and self.asset == TOMAN:
            return self.amount
        return None


class TradeError(ValueError):
    """A message that is clearly a trade but can't be recorded; str() is a Persian reason."""


def normalize(text: str) -> str:
    return (text or "").translate(_NORMALIZE).replace("‌", " ")


def _num(text: str, mult: str | None) -> Decimal:
    value = Decimal(text.replace(",", ""))
    return value * MULTIPLIERS[mult.lower()] if mult else value


def parse_trade(text: str, default_asset: str = "USDT") -> Trade | None:
    """Return a Trade if text matches the trade syntax, else None.

    "#خرید ۵۰۰ میلیون تومان تتر به قیمت ۲۶۴۰۰۰" is a toman amount: the asset
    amount is 500,000,000 / 264,000 and the toman total stays exact. Raises
    TradeError when such a message has no price.
    """
    m = TRADE_RE.match(normalize(text))
    if not m:
        return None
    try:
        amount = _num(m["amount"], m["mult"])
        rate = _num(m["rate"], m["rmult"]) if m["rate"] else None
    except InvalidOperation:
        return None
    if amount <= 0 or (rate is not None and rate <= 0):
        return None
    asset = m["asset"] or default_asset
    asset = ASSETS.get(asset, asset.upper())
    toman_total = None
    if m["toman"]:
        if rate is None:
            raise TradeError(
                "برای معامله با مبلغ تومانی، قیمت لازم است. مثال:\n"
                "#خرید ۵۰۰ میلیون تومان تتر به قیمت ۲۶۴۰۰۰"
            )
        toman_total = amount
        places = Decimal(1).scaleb(-PRECISION.get(asset, 8))
        amount = (toman_total / rate).quantize(places, rounding=ROUND_HALF_UP)
        if amount <= 0:
            return None
    return Trade(
        side=SIDES[m["side"].lower()],
        amount=amount,
        asset=asset,
        rate=rate,
        note=(m["note"] or "").strip(),
        toman_total=toman_total,
    )


def parse_payment(text: str) -> Trade | None:
    """Return a PAY/RECEIVE entry if text matches the payment syntax, else None."""
    m = PAYMENT_RE.match(normalize(text))
    if not m:
        return None
    try:
        amount = _num(m["amount"], m["mult"])
    except InvalidOperation:
        return None
    if amount <= 0:
        return None
    asset = m["asset"] or TOMAN
    return Trade(
        side=PAYMENT_SIDES[m["side"].lower()],
        amount=amount,
        asset=ASSETS.get(asset.lower(), asset.upper()),
        note=(m["note"] or "").strip(),
    )


def parse_message(text: str, default_asset: str = "USDT") -> Trade | None:
    return parse_trade(text, default_asset) or parse_payment(text)


def fmt_num(value: Decimal) -> str:
    """1234567.5 -> '1,234,567.5'; drops trailing zeros."""
    q = value.normalize()
    if q == q.to_integral():
        return f"{q:,.0f}"
    return f"{q:,f}".rstrip("0").rstrip(".")


_TO_FA = str.maketrans("0123456789,.", "۰۱۲۳۴۵۶۷۸۹٬٫")


def fa(value) -> str:
    """Format a number (or any string) with Persian digits."""
    s = fmt_num(value) if isinstance(value, Decimal) else str(value)
    return s.translate(_TO_FA)


def asset_name(code: str) -> str:
    return ASSET_NAMES.get(code, code)
