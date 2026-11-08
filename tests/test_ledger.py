from decimal import Decimal as D

from accbot.ledger import summarize
from accbot.parser import Trade


def owed(acc):
    return dict(acc.debts())


def test_trades_create_opposite_debts():
    acc = summarize([
        Trade("BUY", D(100), "USDT", D(275000)),   # client owes 100 USDT, we owe 27.5M
        Trade("SELL", D(300), "USDT", D(320000)),  # we owe 300 USDT, client owes 96M
    ])
    assert owed(acc) == {"USDT": D(-200), "IRT": D(68_500_000)}


def test_payments_settle_debts():
    acc = summarize([
        Trade("BUY", D(100), "USDT", D(275000)),
        Trade("PAY", D(27_500_000), "IRT"),   # we paid the toman
        Trade("RECEIVE", D(100), "USDT"),     # client delivered the tether
    ])
    assert owed(acc) == {"USDT": D(0), "IRT": D(0)}
    assert acc.paid == {"IRT": D(27_500_000)}
    assert acc.received == {"USDT": D(100)}


def test_toman_sell_debts():
    from accbot.parser import parse_trade
    acc = summarize([parse_trade("#فروش ۵۰۰ میلیون تومان به قیمت ۲۶۴۰۰۰")])
    assert owed(acc) == {"USDT": D("-1893.94"), "IRT": D(500_000_000)}


def test_partial_payment():
    acc = summarize([Trade("SELL", D(100), "USDT", D(300000)), Trade("RECEIVE", D(10_000_000), "IRT")])
    assert owed(acc) == {"USDT": D(-100), "IRT": D(20_000_000)}


def test_unpriced_trade_skips_toman_leg():
    acc = summarize([Trade("BUY", D(50), "USDT")])
    assert owed(acc) == {"USDT": D(50)}
    assert acc.unpriced == 1


def test_trade_stats():
    acc = summarize([
        Trade("BUY", D(100), "USDT", D(275000)),
        Trade("BUY", D(200), "USDT", D(280000)),
        Trade("SELL", D(50), "USDT"),
        Trade("BUY", D(1), "BTC"),
    ])
    usdt, btc = acc.trades
    assert (usdt.asset, btc.asset) == ("USDT", "BTC")
    assert (usdt.bought, usdt.sold) == (D(300), D(50))
    assert usdt.avg_buy.quantize(1) == D(278333)
    assert usdt.unpriced == 1
