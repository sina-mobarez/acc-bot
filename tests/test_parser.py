from decimal import Decimal

import pytest

from accbot.parser import TradeError, fa, fmt_num, parse_message, parse_payment, parse_trade


@pytest.mark.parametrize(
    "text, side, amount, asset, rate",
    [
        ("#خرید ۱۰۰ تا تتر رو قیمت ۲۷۵۰۰۰ تومن", "BUY", "100", "USDT", "275000"),
        ("#فروش ۳۰۰ تا تتر رو قیمت ۳۲۰۰۰۰", "SELL", "300", "USDT", "320000"),
        ("#خرید ۲ میلیون تتر", "BUY", "2000000", "USDT", None),
        ("#فروش ۱٫۵ میلیون تتر", "SELL", "1500000", "USDT", None),
        ("#خرید ۱۰۰ تتر به قیمت ۲۷۵٬۵۰۰", "BUY", "100", "USDT", "275500"),
        ("#فروش ۵۰۰ تتر ۲۷۵ هزار تومان", "SELL", "500", "USDT", "275000"),
        ("#خرید ۱۰۰ دلار فی ۹۰۰۰۰", "BUY", "100", "USD", "90000"),
        ("#خرید ۱۰۰ تا رو قیمت ۲۷۵۰۰۰", "BUY", "100", "USDT", "275000"),
        ("#خريد ١٠٠ تتر", "BUY", "100", "USDT", None),  # Arabic yeh and digits
        ("#sell 100 usdt", "SELL", "100", "USDT", None),
        ("#buy 2 m usdt", "BUY", "2000000", "USDT", None),
        ("#buy 2 milion usdt", "BUY", "2000000", "USDT", None),
        ("#sell 250k usdt @ 3.6725", "SELL", "250000", "USDT", "3.6725"),
        ("#buy 100 btc", "BUY", "100", "BTC", None),
        ("#buy 500", "BUY", "500", "USDT", None),
        ("# فروش ۳۰۰ تتر ۳۲۰۰۰۰", "SELL", "300", "USDT", "320000"),
    ],
)
def test_parses(text, side, amount, asset, rate):
    t = parse_trade(text)
    assert t is not None
    assert (t.side, t.amount, t.asset) == (side, Decimal(amount), asset)
    assert t.rate == (Decimal(rate) if rate else None)


def test_note_after_rate():
    t = parse_trade("#فروش ۵۰۰ تتر رو قیمت ۲۷۵۰۰۰ تومن بانک ملت")
    assert t.note == "بانک ملت"
    assert t.total == Decimal("137500000")


@pytest.mark.parametrize(
    "text",
    ["سلام", "#سلام", "خریدم ۱۰۰ تتر", "پرداخت شد", "دریافتی ۱۰۰", "فردا خرید ۱۰۰ تتر", "خرید تتر", "buy usdt",
     "selling 100 usdt", "buy 0 usdt", ""],
)
def test_rejects_non_trades(text):
    assert parse_message(text) is None


def test_formatting():
    assert fmt_num(Decimal("2000000")) == "2,000,000"
    assert fmt_num(Decimal("1500.50")) == "1,500.5"
    assert fa(Decimal("27500000")) == "۲۷٬۵۰۰٬۰۰۰"


@pytest.mark.parametrize(
    "text, side, amount, asset, note",
    [
        ("#دریافت ۵۰ میلیون تومن کارت به کارت", "RECEIVE", "50000000", "IRT", "کارت به کارت"),
        ("#پرداخت ۲۷٬۵۰۰٬۰۰۰ بانک ملت", "PAY", "27500000", "IRT", "بانک ملت"),
        ("#پرداخت ۱۰۰ تتر", "PAY", "100", "USDT", ""),
        ("#ارسال ۲۰۰ تتر شبکه ترون", "PAY", "200", "USDT", "شبکه ترون"),
        ("#دریافت ۱۰۰ USDT", "RECEIVE", "100", "USDT", ""),
        ("#receive 1m toman", "RECEIVE", "1000000", "IRT", ""),
    ],
)
def test_parses_payments(text, side, amount, asset, note):
    p = parse_payment(text)
    assert (p.side, p.amount, p.asset, p.note) == (side, Decimal(amount), asset, note)
    assert p.is_payment and p.rate is None


def test_toman_payment_total():
    assert parse_payment("#دریافت ۵ میلیون").total == Decimal(5_000_000)
    assert parse_payment("#پرداخت ۱۰۰ تتر").total is None


@pytest.mark.parametrize(
    "text", ["خرید ۱۰۰ تا تتر رو قیمت ۲۷۵۰۰۰ تومن", "فروش ۳۰۰ تتر", "دریافت ۵۰ میلیون تومن", "buy 2 m usdt"],
)
def test_requires_hashtag(text):
    assert parse_message(text) is None
    assert parse_message("#" + text) is not None


@pytest.mark.parametrize(
    "text, side, toman, rate, amount",
    [
        ("#خرید ۵۰۰ میلیون تومان به قیمت ۲۶۴۰۰۰", "BUY", "500000000", "264000", "1893.94"),
        ("#خرید ۱ میلیارد تومن تتر به قیمت ۲۶۵۰۰۰", "BUY", "1000000000", "265000", "3773.58"),
        ("#فروش ۲۶۴ میلیون تومن تتر ۲۶۴۰۰۰", "SELL", "264000000", "264000", "1000"),
        ("#فروش ۵۰۰ میلیون تومان به قیمت ۲۶۴۰۰۰", "SELL", "500000000", "264000", "1893.94"),
        ("#فروش ۱ میلیارد تومن تتر به قیمت ۲۶۵۰۰۰", "SELL", "1000000000", "265000", "3773.58"),
        ("#خرید ۵۰۰ میلیون تومان تتر فی ۲۶۴ هزار بانک ملت", "BUY", "500000000", "264000", "1893.94"),
    ],
)
def test_toman_amount_converts_to_asset(text, side, toman, rate, amount):
    t = parse_trade(text)
    assert (t.side, t.asset, t.rate) == (side, "USDT", Decimal(rate))
    assert t.amount == Decimal(amount)
    assert t.total == Decimal(toman)  # exact, not amount × rate
    assert t.by_toman


def test_toman_amount_without_price_is_an_error():
    with pytest.raises(TradeError):
        parse_trade("#خرید ۵۰۰ میلیون تومان تتر")


def test_unit_amount_is_not_by_toman():
    assert not parse_trade("#خرید ۱۰۰ تتر ۲۶۴۰۰۰").by_toman
