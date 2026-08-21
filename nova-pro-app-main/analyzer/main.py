"""Minimal day-trade analyzer for 股市小幫手.

Run locally:
  pip install -r requirements.txt
  uvicorn main:app --host 127.0.0.1 --port 8090 --reload

Deploy later on Render/Railway with the same entrypoint.
"""

from __future__ import annotations

import os
from typing import Any, Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

Stance = Literal["看漲", "看跌", "盤整"]

app = FastAPI(title="Stock Helper Analyzer", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Bar(BaseModel):
    open: float
    high: float
    low: float
    close: float
    volume: float = 0


class AnalyzeRequest(BaseModel):
    code: str
    name: str | None = None
    bars: list[Bar] = Field(default_factory=list)
    stop_pct: float = 0.01
    take_pct: float = 0.02


class AnalyzeResponse(BaseModel):
    score: int
    stance: Stance
    reasons: list[str]
    entry: float | None = None
    stop: float | None = None
    take: float | None = None
    rr: float | None = None
    source: str = "python"
    coach: str | None = None
    at: str | None = None


def _sma(closes: list[float], n: int) -> float | None:
    if len(closes) < n:
        return None
    return sum(closes[-n:]) / n


def _rsi(closes: list[float], n: int = 14) -> float | None:
    if len(closes) <= n:
        return None
    gains = 0.0
    losses = 0.0
    for i in range(-n, 0):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gains += d
        else:
            losses -= d
    if losses == 0:
        return 100.0
    rs = (gains / n) / (losses / n)
    return 100 - (100 / (1 + rs))


def _vwap(bars: list[Bar]) -> float | None:
    if not bars:
        return None
    pv = 0.0
    vol = 0.0
    for b in bars[-60:]:
        typical = (b.high + b.low + b.close) / 3
        pv += typical * b.volume
        vol += b.volume
    if vol <= 0:
        return bars[-1].close
    return pv / vol


def score_bars(bars: list[Bar], stop_pct: float, take_pct: float) -> dict[str, Any]:
    if len(bars) < 30:
        return {
            "score": 0,
            "stance": "盤整",
            "reasons": ["資料量不足，至少需要 30 根 K 棒"],
            "entry": None,
            "stop": None,
            "take": None,
            "rr": None,
        }

    closes = [b.close for b in bars]
    close = closes[-1]
    ma20 = _sma(closes, 20) or close
    ma60 = _sma(closes, 60) or close
    last_vwap = _vwap(bars) or close
    last_rsi = _rsi(closes, 14) or 50.0
    prev = closes[-2]
    latest_vol = bars[-1].volume
    avg20_vol = sum(b.volume for b in bars[-20:]) / 20 or latest_vol

    score = 0
    reasons: list[str] = []

    if close > ma20:
        score += 18
        reasons.append("站上 MA20")
    else:
        score -= 18
        reasons.append("跌破 MA20")

    if close > ma60:
        score += 14
        reasons.append("長趨勢高於 MA60")
    else:
        score -= 14
        reasons.append("長趨勢低於 MA60")

    if close > last_vwap:
        score += 12
        reasons.append("現價高於 VWAP")
    else:
        score -= 12
        reasons.append("現價低於 VWAP")

    mom = ((close - prev) / (prev or close)) * 100
    if mom > 0.35:
        score += 10
        reasons.append("短線動能轉強")
    elif mom < -0.35:
        score -= 10
        reasons.append("短線動能轉弱")

    if 55 <= last_rsi <= 72:
        score += 12
        reasons.append(f"RSI {last_rsi:.1f} 偏多")
    elif 28 <= last_rsi <= 45:
        score -= 12
        reasons.append(f"RSI {last_rsi:.1f} 偏空")
    elif last_rsi > 72:
        score -= 6
        reasons.append(f"RSI {last_rsi:.1f} 過熱")
    elif last_rsi < 28:
        score += 6
        reasons.append(f"RSI {last_rsi:.1f} 超賣反彈區")

    if latest_vol > avg20_vol * 1.35:
        score += 8
        reasons.append("量能放大")
    elif latest_vol < avg20_vol * 0.7:
        score -= 4
        reasons.append("量能偏弱")

    score = max(-100, min(100, round(score)))
    stance: Stance = "看漲" if score >= 18 else "看跌" if score <= -18 else "盤整"

    entry = stop = take = rr = None
    if stance == "看漲":
        entry = round(close, 2)
        stop = round(close * (1 - stop_pct), 2)
        take = round(close * (1 + take_pct), 2)
        rr = round(take_pct / stop_pct, 1)
    elif stance == "看跌":
        entry = round(close, 2)
        stop = round(close * (1 + stop_pct), 2)
        take = round(close * (1 - take_pct), 2)
        rr = round(take_pct / stop_pct, 1)

    return {
        "score": score,
        "stance": stance,
        "reasons": reasons[:4],
        "entry": entry,
        "stop": stop,
        "take": take,
        "rr": rr,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "analyzer",
        "gemini": bool(os.environ.get("GEMINI_API_KEY")),
    }


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    from datetime import datetime

    core = score_bars(req.bars, req.stop_pct, req.take_pct)
    coach = None
    # Optional Gemini note — kept short; never invent orders.
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key and len(req.bars) >= 30:
        try:
            coach = _gemini_coach(key, req, core)
        except Exception as exc:  # noqa: BLE001
            coach = f"（Gemini 暫不可用：{exc}）"

    return AnalyzeResponse(
        **core,
        source="python",
        coach=coach,
        at=datetime.now().strftime("%H:%M:%S"),
    )


def _gemini_coach(key: str, req: AnalyzeRequest, core: dict[str, Any]) -> str:
    import json
    import urllib.request

    prompt = (
        "你是台股當沖紀律教練，不是投顧。根據下列量化結果給 2-4 句繁中提醒，"
        "強調風險與條件，禁止保證獲利、禁止「建議買入/賣出」用語。\n"
        f"代碼={req.code} 名稱={req.name or ''} "
        f"stance={core['stance']} score={core['score']} "
        f"reasons={', '.join(core['reasons'])} "
        f"entry={core.get('entry')} stop={core.get('stop')} take={core.get('take')} rr={core.get('rr')}"
    )
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": 220},
    }
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.0-flash:generateContent?key={key}"
    )
    http_req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(http_req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    text = (
        payload.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
        .strip()
    )
    return text or "（Gemini 無回覆）"
