# OpenBB

[OpenBB](https://github.com/OpenBB-finance/OpenBB) is an open-source platform for investment research. It gives you stock prices, economic data and more from Python.

## Install

Python 3.10–3.13:

```bash
cd openbb
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

OpenBB 5 moved stock data out of the base `openbb` package, so `requirements.txt` also installs `openbb-equity`, which adds `obb.equity`, and `openbb-yfinance`, which uses Yahoo Finance as a free data source with no API key.

## Try it

```bash
.venv/bin/python quickstart.py AAPL
```

This prints the last few daily closes for the ticker. The first run takes a little longer because OpenBB builds its command list.

Other data sources, such as FMP, Polygon or Intrinio, need API keys. See the [OpenBB docs](https://docs.openbb.co).
