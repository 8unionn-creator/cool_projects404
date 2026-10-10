"""Quick check that OpenBB is installed and can fetch data.

Run:  .venv/bin/python quickstart.py [TICKER]
"""
import sys

from openbb import obb

symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"

# yfinance needs no API key, so this works out of the box.
prices = obb.equity.price.historical(symbol, provider="yfinance").to_df()
print(f"{symbol}: last {min(5, len(prices))} closes")
print(prices[["close", "volume"]].tail())
