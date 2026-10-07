#!/usr/bin/env python3
"""盤前名單 → 漲停板 收盤後分析（只讀研究，不下單、不改任何策略參數）。

資料來源
- 盤前掃描：server/data/preopen-scans/<date>.jsonl（08:25–09:10 每輪全市場排名）
  或 --base 指向伺服器的 /api/v1/research/preopen-scans
- 收盤真值：證交所 MI_INDEX、櫃買中心 daily_close_quotes（依日期查詢）
- 雷達 EARLY：server/data/early_daily_reports/<date>/live/*/*.json（若存在）

輸出（--out-dir）
- <date>.json   完整數據
- <date>.md     中文摘要（方向、命中率、漏網名單）
- <date>.csv    盤前最後一輪名單逐檔結果

用法
  python3 preopen_limitup.py --date 2026-10-08 --data-dir ../data --out-dir ../data/preopen-reports
  python3 preopen_limitup.py --date 2026-10-08 --base https://stock-helper-api-ruao.onrender.com
  python3 preopen_limitup.py --days 10 --data-dir ../data   # 多日合併，方向更可靠

結束碼：0 成功；2 沒有盤前掃描資料；3 收盤資料尚未公布（稍後重試）；1 其他錯誤
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import re
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import ROUND_FLOOR, Decimal
from typing import Any

TPE = timezone(timedelta(hours=8))
UA = "Mozilla/5.0 (stock-helper preopen analysis)"
TOP_KS = (5, 10, 20, 30, 50)
CHECKPOINTS = ("08:35", "08:40", "08:45", "08:50", "08:55", "08:59")
MIN_RULE_N = 3

EXIT_NO_SCANS = 2
EXIT_EOD_NOT_READY = 3


class EodNotReady(Exception):
    pass


# ---------------------------------------------------------------- limit-up price


def tick_size(price: Decimal) -> Decimal:
    if price < 10:
        return Decimal("0.01")
    if price < 50:
        return Decimal("0.05")
    if price < 100:
        return Decimal("0.1")
    if price < 500:
        return Decimal("0.5")
    if price < 1000:
        return Decimal("1")
    return Decimal("5")


def limit_up_price(reference: float) -> float:
    """台股漲停價：參考價 ×1.10，依該價位檔位無條件捨去。"""
    raw = Decimal(str(reference)) * Decimal("1.1")
    tick = tick_size(raw)
    return float((raw / tick).to_integral_value(rounding=ROUND_FLOOR) * tick)


# ---------------------------------------------------------------- http helpers


def http_get(url: str, timeout: int = 60, attempts: int = 5) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except Exception as err:  # noqa: BLE001
            last = err
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def num(v: Any) -> float | None:
    if v is None:
        return None
    s = re.sub(r"<[^>]+>", "", str(v)).replace(",", "").strip()
    if s in ("", "--", "---", "X", "除權息", "除息", "除權"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ---------------------------------------------------------------- EOD truth


@dataclass
class Eod:
    code: str
    name: str
    market: str
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    reference: float | None
    limit_up: float | None = None
    touched: bool = False
    closed_limit: bool = False
    change_pct: float | None = None

    def finish(self) -> "Eod":
        if self.reference and self.reference > 0:
            self.limit_up = limit_up_price(self.reference)
            eps = 1e-6
            self.touched = self.high is not None and self.high + eps >= self.limit_up
            self.closed_limit = self.close is not None and self.close + eps >= self.limit_up
            if self.close is not None:
                self.change_pct = round((self.close / self.reference - 1) * 100, 2)
        return self


COMMON_STOCK = re.compile(r"^[1-9]\d{3}$")


def field_index(fields: list[str]) -> dict[str, int]:
    return {re.sub(r"\s+", "", name): i for i, name in enumerate(fields)}


def fetch_twse(ymd: str) -> dict[str, Eod]:
    url = (
        "https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json"
        f"&date={ymd.replace('-', '')}&type=ALLBUT0999"
    )
    data = json.loads(http_get(url))
    if data.get("stat") != "OK":
        raise EodNotReady(f"TWSE: {data.get('stat')}")
    table = None
    for t in data.get("tables", []):
        if "證券代號" in (t.get("fields") or []):
            table = t
            break
    if not table or not table.get("data"):
        raise EodNotReady("TWSE: 個股收盤表尚未公布")
    f = field_index(table["fields"])
    out: dict[str, Eod] = {}
    for row in table["data"]:
        code = str(row[f["證券代號"]]).strip()
        if not COMMON_STOCK.match(code):
            continue
        close = num(row[f["收盤價"]])
        sign_raw = re.sub(r"<[^>]+>", "", str(row[f["漲跌(+/-)"]])).strip()
        diff = num(row[f["漲跌價差"]]) or 0.0
        sign = -1.0 if sign_raw == "-" else 1.0
        reference = None
        if close is not None and sign_raw != "X":
            reference = round(close - sign * diff, 4)
        out[code] = Eod(
            code=code,
            name=str(row[f["證券名稱"]]).strip(),
            market="TSE",
            open=num(row[f["開盤價"]]),
            high=num(row[f["最高價"]]),
            low=num(row[f["最低價"]]),
            close=close,
            reference=reference,
        ).finish()
    return out


def fetch_tpex(ymd: str) -> dict[str, Eod]:
    y, m, d = ymd.split("-")
    roc = f"{int(y) - 1911}/{m}/{d}"
    url = (
        "https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/"
        f"stk_quote_result.php?l=zh-tw&d={roc}&o=json"
    )
    data = json.loads(http_get(url))
    if str(data.get("date", "")) != ymd.replace("-", ""):
        raise EodNotReady(f"TPEx: date={data.get('date')}")
    tables = data.get("tables") or []
    if not tables or not tables[0].get("data"):
        raise EodNotReady("TPEx: 收盤行情尚未公布")
    t = tables[0]
    f = field_index(t["fields"])
    out: dict[str, Eod] = {}
    for row in t["data"]:
        code = str(row[f["代號"]]).strip()
        if not COMMON_STOCK.match(code):
            continue
        close = num(row[f["收盤"]])
        change = num(row[f["漲跌"]])
        reference = round(close - change, 4) if close is not None and change is not None else None
        out[code] = Eod(
            code=code,
            name=str(row[f["名稱"]]).strip(),
            market="OTC",
            open=num(row[f["開盤"]]),
            high=num(row[f["最高"]]),
            low=num(row[f["最低"]]),
            close=close,
            reference=reference,
        ).finish()
    return out


def load_eod(ymd: str, cache_dir: str | None) -> dict[str, Eod]:
    if cache_dir:
        path = os.path.join(cache_dir, f"eod-{ymd}.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                rows = json.load(fh)
            return {r["code"]: Eod(**r) for r in rows}
    eod = fetch_twse(ymd)
    eod.update(fetch_tpex(ymd))
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        with open(os.path.join(cache_dir, f"eod-{ymd}.json"), "w", encoding="utf-8") as fh:
            json.dump([e.__dict__ for e in eod.values()], fh, ensure_ascii=False)
    return eod


# ---------------------------------------------------------------- pre-open scans


@dataclass
class Snap:
    t: datetime
    hm: str
    source: str
    items: list[dict[str, Any]]


def load_scans(ymd: str, data_dir: str | None, base: str | None) -> list[dict[str, Any]]:
    lines: list[str] = []
    if data_dir:
        path = os.path.join(data_dir, "preopen-scans", f"{ymd}.jsonl")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
    if not lines and base:
        try:
            raw = http_get(f"{base.rstrip('/')}/api/v1/research/preopen-scans?date={ymd}")
            lines = raw.decode("utf-8").splitlines()
        except RuntimeError:
            lines = []
    rows = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def is_shadow(r: dict[str, Any]) -> bool:
    """Rows recorded only to compare sources (role "shadow") never drive the analysis."""
    return r.get("role") == "shadow"


def change_snaps(rows: list[dict[str, Any]], source: str | None = None) -> list[Snap]:
    """One snapshot per minute and source; callers ask for 30/50/100 rows, keep the longest list.

    Default: the rows that were actually used (no shadow). With `source`: every row of that
    source, shadow included, for the source comparison.
    """
    best: dict[tuple[str, str], Snap] = {}
    for r in rows:
        if r.get("type") != "ChangePercentRank":
            continue
        if source is None and is_shadow(r):
            continue
        if source is not None and r.get("source") != source:
            continue
        t = datetime.fromisoformat(r["t"].replace("Z", "+00:00")).astimezone(TPE)
        s = Snap(t=t, hm=t.strftime("%H:%M"), source=r.get("source", "?"), items=r.get("items") or [])
        key = (s.hm, s.source)
        cur = best.get(key)
        if cur is None or len(s.items) > len(cur.items) or (len(s.items) == len(cur.items) and s.t > cur.t):
            best[key] = s
    return sorted(best.values(), key=lambda s: s.t)


def trial_pct(item: dict[str, Any]) -> float | None:
    close = item.get("close") or 0
    chg = item.get("change_price") or 0
    ref = close - chg
    if close > 0 and ref > 0:
        return round(chg / ref * 100, 2)
    return None


def live_snaps(snaps: list[Snap]) -> list[Snap]:
    """Only rankings from a live source taken before 09:00 count as pre-open."""
    return [s for s in snaps if s.source in ("shioaji", "fugle") and s.hm < "09:00"]


def snap_at(snaps: list[Snap], hm: str) -> Snap | None:
    best = None
    for s in snaps:
        if s.hm <= hm:
            best = s
    return best


# ---------------------------------------------------------------- per-symbol rows


@dataclass
class Cand:
    date: str
    code: str
    name: str
    final_rank: int | None
    trial_pct: float | None
    trial_close: float | None
    trial_volume: float | None
    volume_ratio: float | None
    at_limit_in_trial: bool
    top10_count: int
    first_seen: str | None
    in_volume_rank: bool
    in_amount_rank: bool
    radar_early_before_0930: bool
    eod: Eod | None = None
    queue: "QueueStats | None" = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class QueueStats:
    """09:00–09:10 limit-up bid queue (封單, lots) from best-bid snapshots."""

    samples: int = 0
    locked_open: bool = False
    q_open: float | None = None
    locked_0905: bool = False
    q_0905: float | None = None
    vol_0905: float | None = None
    opened_after_lock: bool = False
    ever_locked: bool = False


def queue_samples(
    rows: list[dict[str, Any]], source: str | None = None
) -> dict[str, list[tuple[str, dict[str, Any]]]]:
    out: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for r in rows:
        if r.get("type") != "LimitQueue":
            continue
        if source is None and is_shadow(r):
            continue
        if source is not None and r.get("source") != source:
            continue
        hm = datetime.fromisoformat(r["t"].replace("Z", "+00:00")).astimezone(TPE).strftime("%H:%M:%S")
        if hm < "09:00:00":
            continue
        for it in r.get("items") or []:
            out.setdefault(str(it.get("code")), []).append((hm, it))
    for v in out.values():
        v.sort(key=lambda x: x[0])
    return out


def queue_stats(samples: list[tuple[str, dict[str, Any]]], limit_up: float | None) -> QueueStats | None:
    if not samples or not limit_up:
        return None
    eps = 1e-6

    def locked(it: dict[str, Any]) -> bool:
        return (it.get("buy_price") or 0) + eps >= limit_up

    q = QueueStats(samples=len(samples))
    first = samples[0][1]
    q.locked_open = locked(first)
    q.q_open = first.get("buy_volume") if q.locked_open else None
    upto = [it for hm, it in samples if hm < "09:06:00"]
    if upto:
        at = upto[-1]
        q.locked_0905 = locked(at)
        q.q_0905 = at.get("buy_volume") if q.locked_0905 else None
        q.vol_0905 = at.get("total_volume")
    was = False
    for _, it in samples:
        if locked(it):
            was = True
            q.ever_locked = True
        elif was:
            q.opened_after_lock = True
    return q


def build_candidates(
    ymd: str,
    rows: list[dict[str, Any]],
    eod: dict[str, Eod],
    radar_codes: set[str],
) -> tuple[list[Cand], Snap | None, list[Snap]]:
    snaps = live_snaps(change_snaps(rows))
    final = snaps[-1] if snaps else None
    top10_count: dict[str, int] = {}
    first_seen: dict[str, str] = {}
    for cp in CHECKPOINTS:
        s = snap_at(snaps, cp)
        if not s:
            continue
        for it in s.items[:10]:
            top10_count[it["code"]] = top10_count.get(it["code"], 0) + 1
    for s in snaps:
        for it in s.items:
            first_seen.setdefault(it["code"], s.hm)

    vol_codes: set[str] = set()
    amt_codes: set[str] = set()
    for r in rows:
        if r.get("type") not in ("VolumeRank", "AmountRank"):
            continue
        if r.get("source") not in ("shioaji", "fugle") or is_shadow(r):
            continue
        codes = {it["code"] for it in r.get("items") or []}
        if r.get("type") == "VolumeRank":
            vol_codes |= codes
        elif r.get("type") == "AmountRank":
            amt_codes |= codes

    cands: list[Cand] = []
    seen: set[str] = set()
    final_items = final.items if final else []
    for it in final_items:
        code = it["code"]
        seen.add(code)
        e = eod.get(code)
        tp = trial_pct(it)
        at_limit = False
        if e and e.limit_up and it.get("close"):
            at_limit = it["close"] + 1e-6 >= e.limit_up
        cands.append(
            Cand(
                date=ymd,
                code=code,
                name=it.get("name") or (e.name if e else code),
                final_rank=it.get("rank"),
                trial_pct=tp,
                trial_close=it.get("close"),
                trial_volume=it.get("total_volume"),
                volume_ratio=it.get("volume_ratio"),
                at_limit_in_trial=at_limit,
                top10_count=top10_count.get(code, 0),
                first_seen=first_seen.get(code),
                in_volume_rank=code in vol_codes,
                in_amount_rank=code in amt_codes,
                radar_early_before_0930=code in radar_codes,
                eod=e,
            )
        )
    # names seen earlier in the session but gone from the final list
    qs = queue_samples(rows)
    for c in cands:
        c.queue = queue_stats(qs.get(c.code, []), c.eod.limit_up if c.eod else None)
    for code, hm in first_seen.items():
        if code in seen:
            continue
        cands.append(
            Cand(
                date=ymd,
                code=code,
                name=eod[code].name if code in eod else code,
                final_rank=None,
                trial_pct=None,
                trial_close=None,
                trial_volume=None,
                volume_ratio=None,
                at_limit_in_trial=False,
                top10_count=top10_count.get(code, 0),
                first_seen=hm,
                in_volume_rank=code in vol_codes,
                in_amount_rank=code in amt_codes,
                radar_early_before_0930=code in radar_codes,
                eod=eod.get(code),
            )
        )
    return cands, final, snaps


def radar_early_codes(ymd: str, data_dir: str | None, base: str | None) -> set[str]:
    reports: list[dict[str, Any]] = []
    if data_dir:
        for path in glob.glob(os.path.join(data_dir, "early_daily_reports", ymd, "live", "*", "*.json")):
            try:
                with open(path, encoding="utf-8") as fh:
                    reports.append(json.load(fh))
            except (OSError, json.JSONDecodeError):
                continue
    if not reports and base:
        try:
            body = json.loads(
                http_get(f"{base.rstrip('/')}/api/v1/data/radar-rescue/early/daily-report?date={ymd}&source=live")
            )
            reports = [body] if isinstance(body.get("signals"), list) else []
        except (RuntimeError, json.JSONDecodeError):
            reports = []
    cutoff = datetime.strptime(f"{ymd} 09:30", "%Y-%m-%d %H:%M").replace(tzinfo=TPE)
    codes: set[str] = set()
    for rep in reports:
        for s in rep.get("signals", []):
            ms = s.get("triggered_at_ms")
            if ms and datetime.fromtimestamp(ms / 1000, TPE) < cutoff:
                codes.add(str(s.get("symbol")))
    return codes


# ---------------------------------------------------------------- Fugle vs Shioaji


def source_compare(rows: list[dict[str, Any]], eod: dict[str, Eod]) -> dict[str, Any] | None:
    """Same-day comparison of the two live sources: ranking overlap, trial %, hit rate, bid queue."""
    fg = live_snaps(change_snaps(rows, "fugle"))
    sj = live_snaps(change_snaps(rows, "shioaji"))
    fq = queue_samples(rows, "fugle")
    sq = queue_samples(rows, "shioaji")
    if not (fg and sj) and not (fq and sq):
        return None

    def closed(items: list[dict[str, Any]]) -> int:
        return sum(1 for it in items if it["code"] in eod and eod[it["code"]].closed_limit)

    ranks = []
    for cp in CHECKPOINTS:
        a, b = snap_at(fg, cp), snap_at(sj, cp)
        if not a or not b:
            continue
        a10, b10 = a.items[:10], b.items[:10]
        a20, b20 = a.items[:20], b.items[:20]
        pa = {it["code"]: trial_pct(it) for it in a20}
        pb = {it["code"]: trial_pct(it) for it in b20}
        both = [c for c in pa if c in pb and pa[c] is not None and pb[c] is not None]
        ranks.append(
            {
                "checkpoint": cp,
                "fugle_at": a.hm,
                "shioaji_at": b.hm,
                "top10_overlap": len({i["code"] for i in a10} & {i["code"] for i in b10}),
                "top20_overlap": len(set(pa) & set(pb)),
                "trial_pct_mismatch": sum(1 for c in both if abs(pa[c] - pb[c]) > 0.05),
                "trial_pct_compared": len(both),
                "fugle_top10_closed_limit": closed(a10),
                "shioaji_top10_closed_limit": closed(b10),
                "fugle_top20_closed_limit": closed(a20),
                "shioaji_top20_closed_limit": closed(b20),
            }
        )

    agree = disagree = 0
    diffs: list[float] = []
    for code, fs in fq.items():
        e = eod.get(code)
        if not e or not e.limit_up:
            continue
        by_t = {hm: it for hm, it in sq.get(code, [])}
        for hm, a in fs:
            b = by_t.get(hm)
            if b is None:
                continue
            la = (a.get("buy_price") or 0) + 1e-6 >= e.limit_up
            lb = (b.get("buy_price") or 0) + 1e-6 >= e.limit_up
            if la == lb:
                agree += 1
                if la and a.get("buy_volume") is not None and b.get("buy_volume") is not None:
                    diffs.append(abs(a["buy_volume"] - b["buy_volume"]))
            else:
                disagree += 1
    diffs.sort()
    return {
        "ranks": ranks,
        "queue": {
            "paired_samples": agree + disagree,
            "locked_agree": agree,
            "locked_disagree": disagree,
            "queue_lots_abs_diff_median": diffs[len(diffs) // 2] if diffs else None,
            "queue_lots_abs_diff_max": diffs[-1] if diffs else None,
        },
    }


def fugle_checks(rows: list[dict[str, Any]]) -> dict[str, Any]:
    ok = 0
    reasons: dict[str, int] = {}
    for r in rows:
        if r.get("type") != "FugleDiag":
            continue
        for d in r.get("items") or []:
            if d.get("ok"):
                ok += 1
            else:
                k = str(d.get("reason"))
                reasons[k] = reasons.get(k, 0) + 1
    return {"ok": ok, "rejected": reasons}


# ---------------------------------------------------------------- statistics


def rate(hit: int, n: int) -> float | None:
    return round(hit / n, 3) if n else None


def tally(cands: list[Cand]) -> dict[str, Any]:
    with_eod = [c for c in cands if c.eod and c.eod.limit_up]
    n = len(with_eod)
    closed = sum(1 for c in with_eod if c.eod.closed_limit)
    touched = sum(1 for c in with_eod if c.eod.touched)
    return {
        "n": n,
        "closed_limit": closed,
        "touched_limit": touched,
        "closed_rate": rate(closed, n),
        "touched_rate": rate(touched, n),
    }


def checkpoint_table(snaps: list[Snap], eod: dict[str, Eod]) -> list[dict[str, Any]]:
    out = []
    for cp in CHECKPOINTS:
        s = snap_at(snaps, cp)
        if not s:
            continue
        for k in TOP_KS:
            items = s.items[:k]
            rows = [eod[it["code"]] for it in items if it["code"] in eod and eod[it["code"]].limit_up]
            n = len(rows)
            closed = sum(1 for e in rows if e.closed_limit)
            touched = sum(1 for e in rows if e.touched)
            out.append(
                {
                    "checkpoint": cp,
                    "snapshot_at": s.hm,
                    "source": s.source,
                    "top_k": k,
                    "n": n,
                    "closed_limit": closed,
                    "touched_limit": touched,
                    "closed_rate": rate(closed, n),
                    "touched_rate": rate(touched, n),
                }
            )
    return out


RULES: list[tuple[str, Any]] = [
    ("試撮價已在漲停價", lambda c: c.at_limit_in_trial),
    ("試撮漲幅 ≥ 9%", lambda c: (c.trial_pct or 0) >= 9),
    ("試撮漲幅 7–9%", lambda c: 7 <= (c.trial_pct or 0) < 9),
    ("試撮漲幅 5–7%", lambda c: 5 <= (c.trial_pct or 0) < 7),
    ("試撮漲幅 3–5%", lambda c: 3 <= (c.trial_pct or 0) < 5),
    ("最後排名前 5", lambda c: c.final_rank is not None and c.final_rank <= 5),
    ("最後排名前 10", lambda c: c.final_rank is not None and c.final_rank <= 10),
    ("最後排名 11–30", lambda c: c.final_rank is not None and 10 < c.final_rank <= 30),
    ("6 個檢查點都在前 10", lambda c: c.top10_count >= 6),
    ("≥ 4 個檢查點在前 10", lambda c: c.top10_count >= 4),
    ("08:40 前就出現", lambda c: (c.first_seen or "99") < "08:40"),
    ("同時在成交量排行", lambda c: c.in_volume_rank),
    ("同時在成交金額排行", lambda c: c.in_amount_rank),
    ("雷達 09:30 前出 EARLY", lambda c: c.radar_early_before_0930),
    ("最後一輪掉出名單", lambda c: c.final_rank is None),
    ("09:00 開盤即鎖漲停", lambda c: bool(c.queue and c.queue.locked_open)),
    ("開盤鎖住、09:05 仍鎖住", lambda c: bool(c.queue and c.queue.locked_open and c.queue.locked_0905)),
    ("開盤鎖住、10 分鐘內被打開", lambda c: bool(c.queue and c.queue.locked_open and c.queue.opened_after_lock)),
    (
        "09:05 封單 ≥ 開盤封單",
        lambda c: bool(
            c.queue and c.queue.q_open and c.queue.q_0905 is not None and c.queue.q_0905 >= c.queue.q_open
        ),
    ),
    (
        "09:05 封單縮到開盤一半以下或打開",
        lambda c: bool(
            c.queue
            and c.queue.q_open
            and (c.queue.q_0905 is None or c.queue.q_0905 < c.queue.q_open / 2)
        ),
    ),
    ("09:05 封單 ≥ 1000 張", lambda c: bool(c.queue and (c.queue.q_0905 or 0) >= 1000)),
    ("09:05 封單 200–1000 張", lambda c: bool(c.queue and 200 <= (c.queue.q_0905 or 0) < 1000)),
    ("09:05 封單 < 200 張", lambda c: bool(c.queue and c.queue.q_0905 is not None and c.queue.q_0905 < 200)),
    (
        "09:05 封單 ≥ 當時成交量",
        lambda c: bool(c.queue and c.queue.q_0905 and c.queue.vol_0905 and c.queue.q_0905 >= c.queue.vol_0905),
    ),
    ("09:00 沒鎖、10 分鐘內鎖上", lambda c: bool(c.queue and not c.queue.locked_open and c.queue.ever_locked)),
]

COMBOS: list[tuple[str, Any]] = [
    (
        "試撮在漲停價 且 同時在成交量排行",
        lambda c: c.at_limit_in_trial and c.in_volume_rank,
    ),
    (
        "試撮在漲停價 且 ≥4 檢查點在前 10",
        lambda c: c.at_limit_in_trial and c.top10_count >= 4,
    ),
    (
        "試撮漲幅 ≥9% 且 雷達 EARLY",
        lambda c: (c.trial_pct or 0) >= 9 and c.radar_early_before_0930,
    ),
    (
        "排名前 10 且 同時在成交金額排行",
        lambda c: c.final_rank is not None and c.final_rank <= 10 and c.in_amount_rank,
    ),
]


def rule_table(cands: list[Cand]) -> list[dict[str, Any]]:
    out = []
    for label, pred in RULES + COMBOS:
        picked = [c for c in cands if pred(c)]
        t = tally(picked)
        t["rule"] = label
        t["members"] = sorted(f"{c.date}:{c.code}" for c in picked if c.eod and c.eod.limit_up)
        out.append(t)
    return out


def volume_tertiles(cands: list[Cand]) -> list[dict[str, Any]]:
    vols = sorted(c.trial_volume for c in cands if c.trial_volume)
    if len(vols) < 6:
        return []
    lo, hi = vols[len(vols) // 3], vols[2 * len(vols) // 3]
    groups = {
        f"試撮量 低（< {lo:,.0f}）": [c for c in cands if c.trial_volume and c.trial_volume < lo],
        f"試撮量 中（{lo:,.0f}–{hi:,.0f}）": [c for c in cands if c.trial_volume and lo <= c.trial_volume < hi],
        f"試撮量 高（≥ {hi:,.0f}）": [c for c in cands if c.trial_volume and c.trial_volume >= hi],
    }
    out = []
    for label, picked in groups.items():
        t = tally(picked)
        t["rule"] = label
        out.append(t)
    return out


def recall(cands: list[Cand], eod: dict[str, Eod]) -> dict[str, Any]:
    limit_codes = {c for c, e in eod.items() if e.closed_limit}
    final_top20 = {c.code for c in cands if c.final_rank is not None and c.final_rank <= 20}
    final_any = {c.code for c in cands if c.final_rank is not None}
    ever = {c.code for c in cands}
    missed = sorted(limit_codes - ever)
    return {
        "limit_up_closed_market": len(limit_codes),
        "caught_in_final_top20": len(limit_codes & final_top20),
        "caught_in_final_list": len(limit_codes & final_any),
        "caught_ever_preopen": len(limit_codes & ever),
        "missed": [
            {
                "code": c,
                "name": eod[c].name,
                "market": eod[c].market,
                "open_pct": round((eod[c].open / eod[c].reference - 1) * 100, 2)
                if eod[c].open and eod[c].reference
                else None,
            }
            for c in missed
        ],
    }


def direction(rules: list[dict[str, Any]], base_rate: float | None, days: int) -> list[str]:
    usable = [r for r in rules if r["n"] >= MIN_RULE_N and r["closed_rate"] is not None]
    usable.sort(key=lambda r: (r["closed_rate"], r["n"]), reverse=True)
    lines = []
    seen: set[tuple[str, ...]] = set()
    picked = []
    for r in usable:
        sig = tuple(r.get("members") or ())
        if sig and sig in seen:
            continue
        seen.add(sig)
        picked.append(r)
        if len(picked) == 6:
            break
    for r in picked:
        lift = ""
        if base_rate:
            lift = f"，是整份盤前名單平均 {base_rate:.0%} 的 {r['closed_rate'] / base_rate:.1f} 倍"
        lines.append(
            f"{r['rule']}：{r['n']} 檔中 {r['closed_limit']} 檔收漲停"
            f"（{r['closed_rate']:.0%}），{r['touched_limit']} 檔盤中摸過漲停{lift}"
        )
    weak = [r for r in usable if r["closed_rate"] == 0 and r["n"] >= 5]
    for r in weak[:2]:
        lines.append(f"避開：{r['rule']}，{r['n']} 檔沒有一檔收漲停")
    sample_note = (
        f"樣本只有 {days} 個交易日，以上是觀察不是保證；至少累積 10 個交易日再定規則。"
        if days < 10
        else f"樣本 {days} 個交易日。"
    )
    lines.append(sample_note)
    return lines


# ---------------------------------------------------------------- output


def cand_dict(c: Cand) -> dict[str, Any]:
    e = c.eod
    q = c.queue
    return {
        "date": c.date,
        "code": c.code,
        "name": c.name,
        "final_rank": c.final_rank,
        "trial_pct": c.trial_pct,
        "trial_close": c.trial_close,
        "trial_volume": c.trial_volume,
        "at_limit_in_trial": c.at_limit_in_trial,
        "top10_count": c.top10_count,
        "first_seen": c.first_seen,
        "in_volume_rank": c.in_volume_rank,
        "in_amount_rank": c.in_amount_rank,
        "radar_early_before_0930": c.radar_early_before_0930,
        "queue_samples": q.samples if q else 0,
        "queue_locked_open": q.locked_open if q else None,
        "queue_open": q.q_open if q else None,
        "queue_locked_0905": q.locked_0905 if q else None,
        "queue_0905": q.q_0905 if q else None,
        "queue_opened_after_lock": q.opened_after_lock if q else None,
        "eod_limit_up_price": e.limit_up if e else None,
        "eod_high": e.high if e else None,
        "eod_close": e.close if e else None,
        "eod_change_pct": e.change_pct if e else None,
        "eod_touched_limit": e.touched if e else None,
        "eod_closed_limit": e.closed_limit if e else None,
    }


def pct(v: float | None) -> str:
    return "—" if v is None else f"{v:.0%}"


def queue_cell(c: dict[str, Any], at: str) -> str:
    if not c.get("queue_samples"):
        return "—"
    locked = c.get(f"queue_locked_{at}")
    vol = c.get(f"queue_{at}")
    if locked and vol is not None:
        return f"{vol:,.0f} 張"
    if at == "0905" and c.get("queue_locked_open"):
        return "打開"
    return "未鎖"


def write_outputs(report: dict[str, Any], cands: list[Cand], out_dir: str, stem: str) -> list[str]:
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    jpath = os.path.join(out_dir, f"{stem}.json")
    with open(jpath, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)
    paths.append(jpath)

    cpath = os.path.join(out_dir, f"{stem}.csv")
    rows = [cand_dict(c) for c in cands]
    with open(cpath, "w", encoding="utf-8-sig", newline="") as fh:
        if rows:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    paths.append(cpath)

    mpath = os.path.join(out_dir, f"{stem}.md")
    with open(mpath, "w", encoding="utf-8") as fh:
        fh.write(render_markdown(report))
    paths.append(mpath)
    return paths


def render_markdown(r: dict[str, Any]) -> str:
    q = r["data_quality"]
    lines = [f"# 盤前名單 → 漲停板分析（{r['label']}）", ""]
    for w in q["warnings"]:
        lines.append(f"> 注意：{w}")
    if q["warnings"]:
        lines.append("")
    lines += ["## 方向", ""]
    lines += [f"- {d}" for d in r["direction"]]
    rec = r["recall"]
    lines += [
        "",
        "## 抓到多少",
        "",
        f"- 當天全市場收漲停 {rec['limit_up_closed_market']} 檔；"
        f"盤前最後一輪前 20 名抓到 {rec['caught_in_final_top20']} 檔，"
        f"最後一輪名單內 {rec['caught_in_final_list']} 檔，"
        f"盤前任何時間出現過 {rec['caught_ever_preopen']} 檔。",
        f"- 整份盤前名單：{r['overall']['n']} 檔，收漲停 {r['overall']['closed_limit']}"
        f"（{pct(r['overall']['closed_rate'])}），摸漲停 {r['overall']['touched_limit']}"
        f"（{pct(r['overall']['touched_rate'])}）。",
        "",
        "## 各時間點前 K 名命中率（收漲停 / 摸漲停）",
        "",
        "| 時間 | 前 5 | 前 10 | 前 20 | 前 30 | 前 50 |",
        "|---|---|---|---|---|---|",
    ]
    by_cp: dict[str, dict[int, dict[str, Any]]] = {}
    for row in r["checkpoints"]:
        by_cp.setdefault(row["checkpoint"], {})[row["top_k"]] = row
    for cp, ks in by_cp.items():
        cells = []
        for k in TOP_KS:
            x = ks.get(k)
            cells.append("—" if not x or not x["n"] else f"{x['closed_limit']}/{x['touched_limit']} of {x['n']}")
        lines.append(f"| {cp} | " + " | ".join(cells) + " |")
    lines += ["", "## 條件命中率", "", "| 條件 | 檔數 | 收漲停 | 摸漲停 |", "|---|---|---|---|"]
    for row in r["rules"]:
        if row["n"]:
            lines.append(
                f"| {row['rule']} | {row['n']} | {row['closed_limit']}（{pct(row['closed_rate'])}）"
                f" | {row['touched_limit']}（{pct(row['touched_rate'])}） |"
            )
    if r.get("final_top"):
        lines += [
            "",
            "## 盤前最後一輪前 20 名",
            "",
            "| 排名 | 代號 | 名稱 | 試撮漲幅 | 試撮在漲停 | 09:00 封單 | 09:05 封單 | 收盤漲幅 | 收漲停 |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for c in r["final_top"][:20]:
            lines.append(
                f"| {c['final_rank']} | {c['code']} | {c['name']} | "
                f"{'—' if c['trial_pct'] is None else str(c['trial_pct']) + '%'} | "
                f"{'是' if c['at_limit_in_trial'] else ''} | "
                f"{queue_cell(c, 'open')} | {queue_cell(c, '0905')} | "
                f"{'—' if c['eod_change_pct'] is None else str(c['eod_change_pct']) + '%'} | "
                f"{'是' if c['eod_closed_limit'] else ''} |"
            )
    sc = r.get("source_compare")
    if sc:
        lines += ["", "## 富果 vs 永豐（同一天、同一時間點）", ""]
        if sc["ranks"]:
            lines += [
                "| 時間 | 前10 重疊 | 前20 重疊 | 試撮漲幅不一致 | 前10 收漲停 富果/永豐 | 前20 收漲停 富果/永豐 |",
                "|---|---|---|---|---|---|",
            ]
            for x in sc["ranks"]:
                lines.append(
                    f"| {x['checkpoint']} | {x['top10_overlap']}/10 | {x['top20_overlap']}/20 | "
                    f"{x['trial_pct_mismatch']}/{x['trial_pct_compared']} | "
                    f"{x['fugle_top10_closed_limit']}/{x['shioaji_top10_closed_limit']} | "
                    f"{x['fugle_top20_closed_limit']}/{x['shioaji_top20_closed_limit']} |"
                )
        qq = sc["queue"]
        if qq["paired_samples"]:
            lines.append(
                f"- 封單：同時間配對 {qq['paired_samples']} 筆，鎖漲停判斷一致 {qq['locked_agree']}、"
                f"不一致 {qq['locked_disagree']}；封單張數差距中位數 {qq['queue_lots_abs_diff_median']}、"
                f"最大 {qq['queue_lots_abs_diff_max']}。"
            )
    if rec["missed"]:
        lines += ["", "## 漏網：收漲停但盤前沒出現", ""]
        for m in rec["missed"][:30]:
            open_note = "" if m["open_pct"] is None else f"，開盤 {m['open_pct']}%"
            lines.append(f"- {m['code']} {m['name']}（{m['market']}{open_note}）")
    lines += ["", f"_產生時間 {r['generated_at']}_", ""]
    return "\n".join(lines)


# ---------------------------------------------------------------- main


def analyze_day(ymd: str, args: argparse.Namespace) -> tuple[list[Cand], dict[str, Any]]:
    rows = load_scans(ymd, args.data_dir, args.base)
    if not rows:
        raise FileNotFoundError(ymd)
    eod = load_eod(ymd, args.eod_cache)
    radar = radar_early_codes(ymd, args.data_dir, args.base)
    cands, final, snaps = build_candidates(ymd, rows, eod, radar)

    sources: dict[str, int] = {}
    stale = 0
    for r in rows:
        sources[r.get("source", "?")] = sources.get(r.get("source", "?"), 0) + 1
        for it in (r.get("items") or [])[:5]:
            d = str(it.get("date") or "").replace("/", "-")[:10]
            if r.get("source") == "shioaji" and d and d != ymd:
                stale += 1
    warnings = []
    if not snaps:
        warnings.append("盤前沒有任何來自永豐／富果的即時排名（只有昨日名單），這天不能評估盤前名單。")
    if snaps and not any(r.get("type") == "LimitQueue" for r in rows):
        warnings.append("09:00–09:10 沒有封單資料（富果、永豐都沒回應），封單相關條件這天無法評估。")
    checks = fugle_checks(rows)
    if checks["rejected"] and not checks["ok"]:
        warnings.append(
            "富果盤前資料整段沒通過檢查，盤前名單全部來自永豐；原因：" + "、".join(f"{k}×{v}" for k, v in checks["rejected"].items())
        )
    if stale:
        warnings.append(f"有 {stale} 筆永豐排名的日期不是 {ymd}，盤前排名可能是前一日資料。")
    meta = {
        "date": ymd,
        "scan_rows": len(rows),
        "sources": sources,
        "change_snapshots_live": len(snaps),
        "first_live_snapshot": snaps[0].hm if snaps else None,
        "final_snapshot": final.hm if final else None,
        "final_source": final.source if final else None,
        "stale_rank_rows": stale,
        "limit_queue_samples": sum(1 for r in rows if r.get("type") == "LimitQueue" and not is_shadow(r)),
        "limit_queue_sources": sorted({r.get("source", "?") for r in rows if r.get("type") == "LimitQueue" and not is_shadow(r)}),
        "fugle_checks": checks,
        "source_compare": source_compare(rows, eod),
        "warnings": warnings,
        "checkpoints": checkpoint_table(snaps, eod),
        "recall": recall(cands, eod),
        "radar_early_before_0930": len(radar),
    }
    return cands, meta


def taipei_today() -> str:
    return datetime.now(TPE).strftime("%Y-%m-%d")


def scan_dates(data_dir: str | None) -> list[str]:
    if not data_dir:
        return []
    names = glob.glob(os.path.join(data_dir, "preopen-scans", "*.jsonl"))
    return sorted(os.path.basename(n)[:10] for n in names)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="盤前名單 → 漲停板 收盤後分析")
    ap.add_argument("--date", help="YYYY-MM-DD（預設今天台北時間）")
    ap.add_argument("--days", type=int, default=1, help="合併最近 N 個有盤前資料的交易日")
    ap.add_argument("--data-dir", help="server/data 目錄")
    ap.add_argument("--base", help="伺服器網址，例如 https://stock-helper-api-ruao.onrender.com")
    ap.add_argument("--out-dir", help="報告輸出目錄（預設 <data-dir>/preopen-reports）")
    ap.add_argument("--eod-cache", help="收盤資料快取目錄（預設 <out-dir>/eod）")
    args = ap.parse_args(argv)

    out_dir = args.out_dir or (os.path.join(args.data_dir, "preopen-reports") if args.data_dir else "preopen-reports")
    args.eod_cache = args.eod_cache or os.path.join(out_dir, "eod")

    if args.days > 1:
        dates = scan_dates(args.data_dir)
        if args.date:
            dates = [d for d in dates if d <= args.date]
        dates = dates[-args.days :]
    else:
        dates = [args.date or taipei_today()]

    all_cands: list[Cand] = []
    per_day: list[dict[str, Any]] = []
    for ymd in dates:
        try:
            cands, meta = analyze_day(ymd, args)
        except FileNotFoundError:
            print(f"{ymd}: 沒有盤前掃描資料", file=sys.stderr)
            if len(dates) == 1:
                return EXIT_NO_SCANS
            continue
        except EodNotReady as err:
            print(f"{ymd}: 收盤資料尚未公布（{err}）", file=sys.stderr)
            if len(dates) == 1:
                return EXIT_EOD_NOT_READY
            continue
        all_cands += cands
        per_day.append(meta)

    if not per_day:
        return EXIT_NO_SCANS

    overall = tally(all_cands)
    rules = rule_table(all_cands) + volume_tertiles(all_cands)
    label = dates[-1] if len(per_day) == 1 else f"{per_day[0]['date']}～{per_day[-1]['date']}，{len(per_day)} 天"
    last = per_day[-1]
    final_top = sorted(
        (cand_dict(c) for c in all_cands if c.date == last["date"] and c.final_rank is not None),
        key=lambda x: x["final_rank"],
    )
    recall_all = {
        "limit_up_closed_market": sum(d["recall"]["limit_up_closed_market"] for d in per_day),
        "caught_in_final_top20": sum(d["recall"]["caught_in_final_top20"] for d in per_day),
        "caught_in_final_list": sum(d["recall"]["caught_in_final_list"] for d in per_day),
        "caught_ever_preopen": sum(d["recall"]["caught_ever_preopen"] for d in per_day),
        "missed": last["recall"]["missed"],
    }
    report = {
        "label": label,
        "dates": [d["date"] for d in per_day],
        "generated_at": datetime.now(TPE).strftime("%Y-%m-%d %H:%M:%S"),
        "data_quality": {
            "per_day": [
                {k: v for k, v in d.items() if k not in ("checkpoints", "recall", "source_compare")} for d in per_day
            ],
            "warnings": [w for d in per_day for w in d["warnings"]],
        },
        "overall": overall,
        "checkpoints": last["checkpoints"],
        "rules": rules,
        "recall": recall_all,
        "final_top": final_top,
        "source_compare": last["source_compare"],
        "direction": direction(rules, overall["closed_rate"], len(per_day)),
        "mutates_strategy": False,
    }
    stem = dates[-1] if len(per_day) == 1 else f"multi-{per_day[0]['date']}_{per_day[-1]['date']}"
    paths = write_outputs(report, all_cands, out_dir, stem)
    print("\n".join(report["direction"]))
    print("報告：" + ", ".join(paths))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except EodNotReady as err:
        print(f"收盤資料尚未公布：{err}", file=sys.stderr)
        sys.exit(EXIT_EOD_NOT_READY)
