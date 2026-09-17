"""
shioaji-bridge — thin FastAPI wrapper around Sinopac Shioaji (行情 only).

Env:
  SHIOAJI_API_KEY / SJ_API_KEY
  SHIOAJI_SECRET_KEY / SJ_SEC_KEY
  SHIOAJI_PRODUCTION=true|false  (default true)
  SHIOAJI_BRIDGE_PORT=18080

Node talks to http://127.0.0.1:18080 inside the same container.
Never expose this port publicly.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from datetime import date, datetime, timezone
from typing import Any, Literal
from queue import Empty, Queue
import re

import shioaji as sj
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="shioaji-bridge", version="1.0.0")

api: sj.Shioaji | None = None
login_error: str | None = None
event_q: Queue[dict[str, Any]] = Queue(maxsize=5000)
subs_lock = threading.Lock()
active_subs: set[tuple[str, str]] = set()  # (code, quote_type)


def env_key() -> tuple[str, str]:
    key = (
        os.environ.get("SHIOAJI_API_KEY")
        or os.environ.get("SJ_API_KEY")
        or ""
    ).strip()
    secret = (
        os.environ.get("SHIOAJI_SECRET_KEY")
        or os.environ.get("SJ_SEC_KEY")
        or ""
    ).strip()
    return key, secret


def is_production() -> bool:
    raw = (
        os.environ.get("SHIOAJI_PRODUCTION")
        or os.environ.get("SJ_PRODUCTION")
        or "true"
    ).strip().lower()
    return raw not in ("0", "false", "no", "sim", "simulation")


def _as_dict(obj: Any) -> dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "to_dict"):
        try:
            return dict(obj.to_dict())  # type: ignore[no-untyped-call]
        except Exception:
            pass
    try:
        return dict(obj)  # type: ignore[arg-type]
    except Exception:
        pass
    out: dict[str, Any] = {}
    for k in dir(obj):
        if k.startswith("_"):
            continue
        try:
            v = getattr(obj, k)
        except Exception:
            continue
        if callable(v):
            continue
        out[k] = v
    return out


def _register_quote_callbacks(client: sj.Shioaji) -> None:
    """shioaji 1.7+ removed @quote.on_quote; use v1 tick/bidask callbacks."""

    def _on_tick(exchange: Any, tick: Any) -> None:
        try:
            q = _as_dict(tick)
            code = str(q.get("code") or getattr(tick, "code", "") or "")
            ex = str(getattr(exchange, "value", exchange) or "TSE")
            event_q.put_nowait(
                {
                    "type": "quote",
                    "topic": f"MKT/{ex}/{code}",
                    "quote": q,
                }
            )
        except Exception:
            pass

    def _on_bidask(exchange: Any, bidask: Any) -> None:
        try:
            q = _as_dict(bidask)
            code = str(q.get("code") or getattr(bidask, "code", "") or "")
            ex = str(getattr(exchange, "value", exchange) or "TSE")
            event_q.put_nowait(
                {
                    "type": "quote",
                    "topic": f"BIDASK/{ex}/{code}",
                    "quote": q,
                }
            )
        except Exception:
            pass

    quote = client.quote
    if hasattr(quote, "set_on_tick_stk_v1_callback"):
        quote.set_on_tick_stk_v1_callback(_on_tick)
    if hasattr(quote, "set_on_bidask_stk_v1_callback"):
        quote.set_on_bidask_stk_v1_callback(_on_bidask)
    if hasattr(quote, "set_on_tick_fop_v1_callback"):
        quote.set_on_tick_fop_v1_callback(_on_tick)
    if hasattr(quote, "set_on_bidask_fop_v1_callback"):
        quote.set_on_bidask_fop_v1_callback(_on_bidask)
    if (
        not hasattr(quote, "set_on_tick_stk_v1_callback")
        and hasattr(quote, "set_quote_callback")
    ):
        # legacy fallback
        def _on_quote(topic: str, raw: dict) -> None:  # type: ignore[no-untyped-def]
            try:
                event_q.put_nowait({"type": "quote", "topic": topic, "quote": raw})
            except Exception:
                pass

        quote.set_quote_callback(_on_quote)


def ensure_api() -> sj.Shioaji:
    global api, login_error
    if api is not None:
        return api
    key, secret = env_key()
    if not key or not secret:
        raise HTTPException(
            status_code=503,
            detail="缺少 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY",
        )
    try:
        client = sj.Shioaji(simulation=not is_production())
        client.login(api_key=key, secret_key=secret)
        _register_quote_callbacks(client)
        api = client
        login_error = None
        return client
    except Exception as err:  # noqa: BLE001
        login_error = str(err)
        raise HTTPException(status_code=503, detail=f"Shioaji login 失敗: {err}") from err


def stock_contract(code: str, exchange: str | None = None) -> Any:
    client = ensure_api()
    code = code.strip()
    # Prefer Contracts.Stocks index
    try:
        c = client.Contracts.Stocks[code]
        if c is not None:
            return c
    except Exception:
        pass
    # Fallback by exchange bags
    for bag_name in ("TSE", "OTC", "EXCHANGE"):
        try:
            bag = getattr(client.Contracts.Stocks, bag_name, None)
            if bag is None:
                continue
            c = bag[code]
            if c is not None:
                return c
        except Exception:
            continue
    if exchange:
        try:
            bag = getattr(client.Contracts.Stocks, exchange, None)
            if bag is not None:
                return bag[code]
        except Exception:
            pass
    raise HTTPException(status_code=404, detail=f"找不到商品: {code}")


def _product_contracts(bag: Any) -> list[Any]:
    out: list[Any] = []
    try:
        for item in bag:
            if item is not None and getattr(item, "code", None):
                out.append(item)
    except Exception:
        pass
    if out:
        return out
    for name in dir(bag):
        if name.startswith("_"):
            continue
        try:
            item = getattr(bag, name)
        except Exception:
            continue
        if item is None or callable(item):
            continue
        if getattr(item, "code", None):
            out.append(item)
    return out


def _delivery_key(c: Any) -> str:
    return str(
        getattr(c, "delivery_date", "")
        or getattr(c, "delivery_month", "")
        or getattr(c, "code", "")
        or ""
    )


def front_month_future(client: sj.Shioaji, product: str, which: int = 0) -> Any:
    bag = None
    try:
        bag = getattr(client.Contracts.Futures, product)
    except Exception:
        bag = None
    if bag is None:
        try:
            bag = client.Contracts.Futures[product]
        except Exception:
            bag = None
    if bag is None:
        raise HTTPException(status_code=404, detail=f"找不到期貨商品: {product}")
    try:
        alias = getattr(bag, f"{product}R{which + 1}", None)
        if alias is not None and getattr(alias, "code", None):
            return alias
    except Exception:
        pass
    contracts = _product_contracts(bag)
    today = date.today().isoformat().replace("-", "/")
    alive = [c for c in contracts if _delivery_key(c) >= today]
    pool = sorted(alive or contracts, key=_delivery_key)
    if not pool or which >= len(pool):
        raise HTTPException(
            status_code=404, detail=f"找不到期貨月份: {product} R{which + 1}"
        )
    return pool[which]


def futures_contract(code: str) -> Any:
    client = ensure_api()
    code = code.strip().upper()
    try:
        c = client.Contracts.Futures[code]
        if c is not None and getattr(c, "code", None):
            return c
    except Exception:
        pass
    m = re.fullmatch(r"([A-Z]{2,4})R([12])", code)
    if m:
        return front_month_future(client, m.group(1), int(m.group(2)) - 1)
    raise HTTPException(status_code=404, detail=f"找不到期貨: {code}")


def resolve_contract(
    code: str, security_type: str | None, exchange: str | None = None
) -> Any:
    st = (security_type or "STK").upper()
    if st in ("STK", "STOCK"):
        return stock_contract(code, exchange)
    if st in ("FUT", "FUTURES"):
        return futures_contract(code)
    raise HTTPException(status_code=404, detail=f"不支援 {st}")


def num(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def snapshot_dto(s: Any) -> dict[str, Any]:
    ts = getattr(s, "ts", None) or getattr(s, "datetime", None)
    if isinstance(ts, datetime):
        dt = ts.astimezone(timezone.utc).isoformat()
    elif isinstance(ts, (int, float)) and ts > 0:
        # ns or ms
        x = float(ts)
        if x > 1e14:
            x = x / 1e9
        elif x > 1e11:
            x = x / 1e3
        dt = datetime.fromtimestamp(x, tz=timezone.utc).isoformat()
    else:
        dt = datetime.now(tz=timezone.utc).isoformat()

    change_type = getattr(s, "change_type", None)
    change_type_s = getattr(change_type, "value", change_type) or "Unchanged"
    tick_type = getattr(s, "tick_type", None)
    tick_type_s = getattr(tick_type, "value", tick_type) or ""

    return {
        "code": str(getattr(s, "code", "")),
        "exchange": str(getattr(s, "exchange", "") or ""),
        "datetime": dt,
        "open": num(getattr(s, "open", 0)),
        "high": num(getattr(s, "high", 0)),
        "low": num(getattr(s, "low", 0)),
        "close": num(getattr(s, "close", 0)),
        "average_price": num(getattr(s, "average_price", 0)),
        "buy_price": num(getattr(s, "buy_price", 0)),
        "buy_volume": num(getattr(s, "buy_volume", 0)),
        "sell_price": num(getattr(s, "sell_price", 0)),
        "sell_volume": num(getattr(s, "sell_volume", 0)),
        "volume": int(num(getattr(s, "volume", 0))),
        "total_volume": int(num(getattr(s, "total_volume", 0))),
        "amount": num(getattr(s, "amount", 0)),
        "total_amount": num(getattr(s, "total_amount", 0)),
        "change_price": num(getattr(s, "change_price", 0)),
        "change_rate": num(getattr(s, "change_rate", 0)),
        "change_type": str(change_type_s),
        "tick_type": str(tick_type_s),
        "volume_ratio": num(getattr(s, "volume_ratio", 0)),
        "yesterday_volume": num(getattr(s, "yesterday_volume", 0)),
    }


class ContractKey(BaseModel):
    security_type: str = "STK"
    exchange: str | None = "TSE"
    code: str


class SnapshotsBody(BaseModel):
    contracts: list[ContractKey] = Field(default_factory=list)


class KbarsBody(BaseModel):
    contract: ContractKey
    start: str
    end: str


class TicksBody(BaseModel):
    contract: ContractKey
    date: str
    last_cnt: int | None = None


class ScannerBody(BaseModel):
    scanner_type: str = "VolumeRank"
    count: int = 30
    ascending: bool = False


class SubBody(BaseModel):
    security_type: str = "STK"
    exchange: str | None = "TSE"
    code: str
    quote_type: Literal["Tick", "BidAsk", "tick", "bidask", "Quote"] = "Tick"


@app.on_event("startup")
def _startup() -> None:
    # Login in background so /health binds immediately (Render + start-cloud wait).
    key, secret = env_key()
    if not (key and secret):
        return

    def _bg_login() -> None:
        try:
            ensure_api()
            print("shioaji-bridge: logged in", flush=True)
        except Exception as err:  # noqa: BLE001
            print(f"shioaji-bridge: login deferred ({err})", flush=True)

    threading.Thread(target=_bg_login, name="shioaji-login", daemon=True).start()


@app.get("/health")
def health() -> dict[str, Any]:
    key, secret = env_key()
    return {
        "status": "ok" if api is not None else "degraded",
        "provider": "shioaji",
        "logged_in": api is not None,
        "has_keys": bool(key and secret),
        "production": is_production(),
        "login_error": login_error,
        "subs": len(active_subs),
    }


@app.post("/snapshots")
def snapshots(body: SnapshotsBody) -> list[dict[str, Any]]:
    client = ensure_api()
    contracts = []
    for c in body.contracts[:500]:
        st = (c.security_type or "STK").upper()
        if st not in ("STK", "STOCK", "FUT", "FUTURES"):
            continue
        try:
            contracts.append(resolve_contract(c.code, st, c.exchange))
        except HTTPException:
            continue
    if not contracts:
        return []
    rows = client.snapshots(contracts)
    return [snapshot_dto(s) for s in rows]


@app.post("/kbars")
def kbars(body: KbarsBody) -> dict[str, Any]:
    client = ensure_api()
    contract = resolve_contract(
        body.contract.code, body.contract.security_type, body.contract.exchange
    )
    bars = client.kbars(contract, start=body.start, end=body.end)
    # shioaji returns object with ts/Open/High/Low/Close/Volume arrays
    def arr(name: str) -> list[Any]:
        v = getattr(bars, name, None)
        if v is None:
            return []
        return list(v)

    ts = arr("ts")
    datetimes: list[str] = []
    for t in ts:
        try:
            x = float(t)
            if x > 1e14:
                x = x / 1e9
            elif x > 1e12:
                x = x / 1e3
            datetimes.append(
                datetime.fromtimestamp(x, tz=timezone.utc).isoformat()
            )
        except Exception:
            datetimes.append(str(t))
    return {
        "datetime": datetimes,
        "Open": [num(x) for x in arr("Open")],
        "High": [num(x) for x in arr("High")],
        "Low": [num(x) for x in arr("Low")],
        "Close": [num(x) for x in arr("Close")],
        "Volume": [int(num(x)) for x in arr("Volume")],
        "Amount": [num(x) for x in arr("Amount")],
    }


@app.post("/ticks")
def ticks(body: TicksBody) -> dict[str, Any]:
    client = ensure_api()
    contract = resolve_contract(
        body.contract.code, body.contract.security_type, body.contract.exchange
    )
    ticks_obj = client.ticks(contract, body.date)
    def arr(name: str) -> list[Any]:
        v = getattr(ticks_obj, name, None)
        if v is None:
            return []
        return list(v)

    ts = arr("ts")
    close = arr("close")
    volume = arr("volume")
    bid = arr("bid_price") or arr("bid")
    ask = arr("ask_price") or arr("ask")
    n = len(close)
    if body.last_cnt and body.last_cnt > 0:
        n = min(n, body.last_cnt)
        sl = slice(-n, None)
        ts, close, volume = ts[sl], close[sl], volume[sl]
        if bid:
            bid = bid[sl]
        if ask:
            ask = ask[sl]

    datetimes: list[str] = []
    for t in ts:
        try:
            x = float(t)
            if x > 1e14:
                x = x / 1e9
            datetimes.append(
                datetime.fromtimestamp(x, tz=timezone.utc).isoformat()
            )
        except Exception:
            datetimes.append(str(t))

    return {
        "date": body.date,
        "datetime": datetimes,
        "close": [num(x) for x in close],
        "volume": [int(num(x)) for x in volume],
        "bid_price": [num(x) for x in bid] if bid else [],
        "ask_price": [num(x) for x in ask] if ask else [],
    }


SCANNER_MAP = {
    "ChangePercentRank": "ChangePercentRank",
    "ChangePriceRank": "ChangePriceRank",
    "DayRangeRank": "DayRangeRank",
    "VolumeRank": "VolumeRank",
    "AmountRank": "AmountRank",
    "TickCountRank": "TickCountRank",
}


@app.post("/scanner")
def scanner(body: ScannerBody) -> list[dict[str, Any]]:
    client = ensure_api()
    name = SCANNER_MAP.get(body.scanner_type, "VolumeRank")
    scanner_type = getattr(sj.constant.ScannerType, name, None)
    if scanner_type is None:
        raise HTTPException(status_code=400, detail=f"不支援 scanner: {name}")
    try:
        rows = client.scanners(
            scanner_type=scanner_type,
            count=min(max(body.count, 1), 100),
            ascending=body.ascending,
        )
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"scanner 失敗: {err}") from err

    out: list[dict[str, Any]] = []
    for r in rows or []:
        out.append(
            {
                "code": str(getattr(r, "code", "")),
                "name": str(getattr(r, "name", "") or ""),
                "date": str(getattr(r, "date", "") or ""),
                "close": num(getattr(r, "close", 0)),
                "open": num(getattr(r, "open", 0)),
                "high": num(getattr(r, "high", 0)),
                "low": num(getattr(r, "low", 0)),
                "change_price": num(getattr(r, "change_price", 0)),
                "change_type": int(num(getattr(r, "change_type", 0))),
                "average_price": num(getattr(r, "average_price", 0)),
                "price_range": num(getattr(r, "price_range", 0)),
                "rank_value": num(getattr(r, "rank_value", 0)),
                "total_volume": num(getattr(r, "total_volume", 0)),
                "total_amount": num(getattr(r, "total_amount", 0)),
                "volume_ratio": num(getattr(r, "volume_ratio", 0)),
                "yesterday_volume": num(getattr(r, "yesterday_volume", 0)),
                "tick_type": int(num(getattr(r, "tick_type", 0))),
                "buy_price": num(getattr(r, "buy_price", 0)),
                "sell_price": num(getattr(r, "sell_price", 0)),
            }
        )
    return out


@app.get("/search")
def search(q: str = Query("")) -> dict[str, Any]:
    client = ensure_api()
    needle = q.strip()
    if not needle:
        return {"hits": []}
    hits: list[dict[str, str]] = []
    nq = needle.lower()
    # Contracts.Stocks may be a mapping-like object
    try:
        stocks = client.Contracts.Stocks
        # iterate common boards
        for board in ("TSE", "OTC"):
            bag = getattr(stocks, board, None)
            if bag is None:
                continue
            for code in list(bag)[:5000]:
                try:
                    c = bag[code]
                    name = str(getattr(c, "name", "") or "")
                    code_s = str(getattr(c, "code", code))
                    if nq in code_s.lower() or nq in name.lower() or needle in name:
                        hits.append({"code": code_s, "name": name})
                        if len(hits) >= 30:
                            return {"hits": hits}
                except Exception:
                    continue
    except Exception:
        pass
    # direct get
    try:
        c = stock_contract(needle)
        hits.insert(
            0,
            {
                "code": str(getattr(c, "code", needle)),
                "name": str(getattr(c, "name", "") or ""),
            },
        )
    except HTTPException:
        pass
    return {"hits": hits[:30]}


@app.get("/contracts/{code}")
def contracts(code: str, security_type: str = "STK") -> dict[str, Any]:
    st = security_type.upper()
    if st not in ("STK", "STOCK", "FUT", "FUTURES"):
        raise HTTPException(status_code=404, detail="僅支援 STK / FUT")
    c = resolve_contract(code, st)
    exchange = str(getattr(c, "exchange", "") or ("TAIFEX" if st in ("FUT", "FUTURES") else "TSE"))
    return {
        "security_type": "FUT" if st in ("FUT", "FUTURES") else "STK",
        "exchange": exchange,
        "code": str(getattr(c, "code", code)),
        "symbol": str(getattr(c, "code", code)),
        "name": str(getattr(c, "name", "") or ""),
        "currency": "TWD",
        "category": str(getattr(c, "category", "") or ""),
        "limit_up": num(getattr(c, "limit_up", 0)),
        "limit_down": num(getattr(c, "limit_down", 0)),
        "reference": num(getattr(c, "reference", 0)),
        "update_date": "",
        "day_trade": str(getattr(c, "day_trade", "") or ""),
    }


@app.post("/subscribe")
def subscribe(body: SubBody) -> dict[str, str]:
    client = ensure_api()
    contract = resolve_contract(body.code, body.security_type, body.exchange)
    qt_raw = body.quote_type
    if qt_raw.lower() in ("tick",):
        qt = sj.constant.QuoteType.Tick
        key = "Tick"
    elif qt_raw.lower() in ("bidask", "bid_ask"):
        qt = sj.constant.QuoteType.BidAsk
        key = "BidAsk"
    else:
        qt = sj.constant.QuoteType.Tick
        key = "Tick"
    sub_kw: dict[str, Any] = {"quote_type": qt}
    try:
        sub_kw["version"] = sj.constant.QuoteVersion.v1
    except Exception:
        pass
    client.quote.subscribe(contract, **sub_kw)
    with subs_lock:
        active_subs.add((body.code, key))
    return {"status": "ok", "code": body.code, "quote_type": key}


@app.post("/unsubscribe")
def unsubscribe(body: SubBody) -> dict[str, str]:
    client = ensure_api()
    contract = resolve_contract(body.code, body.security_type, body.exchange)
    qt_raw = body.quote_type
    if qt_raw.lower() in ("bidask", "bid_ask"):
        qt = sj.constant.QuoteType.BidAsk
        key = "BidAsk"
    else:
        qt = sj.constant.QuoteType.Tick
        key = "Tick"
    try:
        client.quote.unsubscribe(contract, quote_type=qt)
    except Exception:
        pass
    with subs_lock:
        active_subs.discard((body.code, key))
    return {"status": "ok"}


@app.get("/events")
async def events() -> StreamingResponse:
    ensure_api()

    async def gen():  # type: ignore[no-untyped-def]
        yield f"data: {json.dumps({'type': 'hello', 'provider': 'shioaji'})}\n\n"
        while True:
            try:
                item = event_q.get_nowait()
                yield f"data: {json.dumps(item, default=str)}\n\n"
            except Empty:
                await asyncio.sleep(0.05)
                # keepalive
                yield ": keepalive\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
