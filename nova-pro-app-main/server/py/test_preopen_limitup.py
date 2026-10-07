"""preopen_limitup 測試。

離線：python3 test_preopen_limitup.py
連網驗證漲停價公式（對照櫃買「次日漲停價」）：PREOPEN_NET=1 python3 test_preopen_limitup.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import preopen_limitup as p  # noqa: E402


class LimitUpPrice(unittest.TestCase):
    def test_tick_boundaries(self) -> None:
        self.assertEqual(p.limit_up_price(9.0), 9.9)
        self.assertEqual(p.limit_up_price(10.0), 11.0)
        self.assertEqual(p.limit_up_price(46.0), 50.6)
        self.assertEqual(p.limit_up_price(47.3), 52.0)
        self.assertEqual(p.limit_up_price(95.0), 104.5)
        self.assertEqual(p.limit_up_price(455.0), 500.5 - 0.5)
        self.assertEqual(p.limit_up_price(950.0), 1045.0)
        self.assertEqual(p.limit_up_price(1000.0), 1100.0)

    def test_rounds_down(self) -> None:
        self.assertEqual(p.limit_up_price(23.45), 25.75)
        self.assertEqual(p.limit_up_price(123.0), 135.0)

    def test_eod_flags(self) -> None:
        e = p.Eod("1234", "x", "TSE", 50.0, 55.0, 49.0, 55.0, 50.0).finish()
        self.assertEqual(e.limit_up, 55.0)
        self.assertTrue(e.touched)
        self.assertTrue(e.closed_limit)
        e2 = p.Eod("1234", "x", "TSE", 50.0, 55.0, 49.0, 54.0, 50.0).finish()
        self.assertTrue(e2.touched)
        self.assertFalse(e2.closed_limit)


def scan_line(t: str, typ: str, source: str, items: list[tuple[str, float, float, float]]) -> str:
    return json.dumps(
        {
            "t": t,
            "type": typ,
            "source": source,
            "items": [
                {
                    "rank": i + 1,
                    "code": code,
                    "name": code,
                    "date": "2026-10-07",
                    "close": close,
                    "change_price": chg,
                    "total_volume": vol,
                }
                for i, (code, close, chg, vol) in enumerate(items)
            ],
        }
    )


def queue_line(t: str, items: list[tuple[str, float, float]]) -> str:
    return json.dumps(
        {
            "t": t,
            "type": "LimitQueue",
            "source": "shioaji",
            "items": [
                {"code": code, "buy_price": bid, "buy_volume": vol, "sell_price": 0, "sell_volume": 0, "total_volume": 1000}
                for code, bid, vol in items
            ],
        }
    )


class SyntheticDay(unittest.TestCase):
    """測試用假資料（只驗證程式流程，不代表任何真實結果）。"""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "preopen-scans"))
        ymd = "2026-10-07"
        eod = [
            p.Eod("1111", "A", "TSE", 55.0, 55.0, 55.0, 55.0, 50.0).finish(),
            p.Eod("2222", "B", "TSE", 21.0, 22.0, 20.5, 21.5, 20.0).finish(),
            p.Eod("3333", "C", "OTC", 30.0, 31.0, 29.0, 30.5, 30.0).finish(),
            p.Eod("4444", "D", "OTC", 11.0, 11.0, 10.5, 11.0, 10.0).finish(),
        ]
        os.makedirs(os.path.join(self.tmp, "eod"))
        with open(os.path.join(self.tmp, "eod", f"eod-{ymd}.json"), "w", encoding="utf-8") as fh:
            json.dump([e.__dict__ for e in eod], fh)
        lines = [
            scan_line("2026-10-06T16:00:00.000Z", "ChangePercentRank", "overnight", [("9999", 10, 1, 1)]),
            scan_line(
                "2026-10-07T00:31:00.000Z",
                "ChangePercentRank",
                "shioaji",
                [("1111", 55.0, 5.0, 300), ("2222", 22.0, 2.0, 100), ("3333", 31.0, 1.0, 50)],
            ),
            scan_line("2026-10-07T00:31:00.000Z", "VolumeRank", "shioaji", [("1111", 55.0, 5.0, 300)]),
            scan_line(
                "2026-10-07T00:59:00.000Z",
                "ChangePercentRank",
                "shioaji",
                [("1111", 55.0, 5.0, 900), ("2222", 21.8, 1.8, 200)],
            ),
            queue_line("2026-10-07T01:00:05.000Z", [("1111", 55.0, 3000), ("2222", 22.0, 500)]),
            queue_line("2026-10-07T01:05:10.000Z", [("1111", 55.0, 4000), ("2222", 21.9, 80)]),
            queue_line("2026-10-07T01:08:00.000Z", [("1111", 55.0, 4500), ("2222", 21.8, 60)]),
        ]
        with open(os.path.join(self.tmp, "preopen-scans", f"{ymd}.jsonl"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        self.ymd = ymd

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_full_run(self) -> None:
        out = os.path.join(self.tmp, "out")
        code = p.main(
            ["--date", self.ymd, "--data-dir", self.tmp, "--out-dir", out, "--eod-cache", os.path.join(self.tmp, "eod")]
        )
        self.assertEqual(code, 0)
        with open(os.path.join(out, f"{self.ymd}.json"), encoding="utf-8") as fh:
            rep = json.load(fh)
        self.assertEqual(rep["overall"]["n"], 3)
        self.assertEqual(rep["overall"]["closed_limit"], 1)
        self.assertEqual(rep["overall"]["touched_limit"], 2)
        self.assertEqual(rep["recall"]["limit_up_closed_market"], 2)
        self.assertEqual(rep["recall"]["caught_ever_preopen"], 1)
        self.assertEqual([m["code"] for m in rep["recall"]["missed"]], ["4444"])
        top = rep["final_top"]
        self.assertEqual(top[0]["code"], "1111")
        self.assertTrue(top[0]["at_limit_in_trial"])
        self.assertTrue(top[0]["in_volume_rank"])
        dropped = [r for r in rep["rules"] if r["rule"] == "最後一輪掉出名單"][0]
        self.assertEqual(dropped["n"], 1)
        rules = {r["rule"]: r for r in rep["rules"]}
        self.assertEqual((rules["09:00 開盤即鎖漲停"]["n"], rules["09:00 開盤即鎖漲停"]["closed_limit"]), (2, 1))
        self.assertEqual((rules["開盤鎖住、09:05 仍鎖住"]["n"], rules["開盤鎖住、09:05 仍鎖住"]["closed_limit"]), (1, 1))
        self.assertEqual(rules["開盤鎖住、10 分鐘內被打開"]["members"], ["2026-10-07:2222"])
        self.assertEqual(rules["09:05 封單 ≥ 開盤封單"]["members"], ["2026-10-07:1111"])
        self.assertEqual(rules["09:05 封單 ≥ 1000 張"]["n"], 1)
        self.assertEqual((top[0]["queue_open"], top[0]["queue_0905"]), (3000, 4000))
        self.assertEqual(top[1]["queue_locked_0905"], False)
        self.assertTrue(top[1]["queue_opened_after_lock"])
        with open(os.path.join(out, f"{self.ymd}.md"), encoding="utf-8") as fh:
            md = fh.read()
        self.assertIn("3,000 張", md)
        self.assertIn("打開", md)
        self.assertEqual(rep["data_quality"]["per_day"][0]["limit_queue_samples"], 3)
        self.assertFalse(rep["mutates_strategy"])
        self.assertTrue(os.path.exists(os.path.join(out, f"{self.ymd}.md")))
        self.assertTrue(os.path.exists(os.path.join(out, f"{self.ymd}.csv")))

    def test_no_scans_exit_code(self) -> None:
        code = p.main(["--date", "2026-10-01", "--data-dir", self.tmp, "--out-dir", os.path.join(self.tmp, "o")])
        self.assertEqual(code, p.EXIT_NO_SCANS)

    def test_overnight_only_warns(self) -> None:
        path = os.path.join(self.tmp, "preopen-scans", f"{self.ymd}.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(scan_line("2026-10-07T00:31:00.000Z", "ChangePercentRank", "overnight", [("1111", 55, 5, 1)]))
        out = os.path.join(self.tmp, "out2")
        code = p.main(
            ["--date", self.ymd, "--data-dir", self.tmp, "--out-dir", out, "--eod-cache", os.path.join(self.tmp, "eod")]
        )
        self.assertEqual(code, 0)
        with open(os.path.join(out, f"{self.ymd}.json"), encoding="utf-8") as fh:
            rep = json.load(fh)
        self.assertEqual(rep["overall"]["n"], 0)
        self.assertTrue(any("昨日名單" in w for w in rep["data_quality"]["warnings"]))

    def test_fugle_primary_shioaji_shadow_compare(self) -> None:
        def shadow(line: str) -> str:
            d = json.loads(line)
            d["role"] = "shadow"
            return json.dumps(d)

        def fq(line: str) -> str:
            d = json.loads(line)
            d["source"] = "fugle"
            return json.dumps(d)

        lines = [
            scan_line(
                "2026-10-07T00:59:00.000Z",
                "ChangePercentRank",
                "fugle",
                [("1111", 55.0, 5.0, 900), ("4444", 11.0, 1.0, 50)],
            ),
            shadow(
                scan_line(
                    "2026-10-07T00:59:00.000Z",
                    "ChangePercentRank",
                    "shioaji",
                    [("1111", 55.0, 5.0, 900), ("2222", 21.8, 1.8, 200)],
                )
            ),
            fq(queue_line("2026-10-07T01:00:05.000Z", [("1111", 55.0, 3000), ("4444", 11.0, 10)])),
            shadow(queue_line("2026-10-07T01:00:05.000Z", [("1111", 55.0, 2990), ("4444", 10.9, 0)])),
            json.dumps({"t": "2026-10-07T00:58:00.000Z", "type": "FugleDiag", "source": "fugle", "items": [{"ok": True}]}),
        ]
        with open(os.path.join(self.tmp, "preopen-scans", f"{self.ymd}.jsonl"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        out = os.path.join(self.tmp, "out3")
        code = p.main(
            ["--date", self.ymd, "--data-dir", self.tmp, "--out-dir", out, "--eod-cache", os.path.join(self.tmp, "eod")]
        )
        self.assertEqual(code, 0)
        with open(os.path.join(out, f"{self.ymd}.json"), encoding="utf-8") as fh:
            rep = json.load(fh)
        self.assertEqual([c["code"] for c in rep["final_top"]], ["1111", "4444"])
        day = rep["data_quality"]["per_day"][0]
        self.assertEqual(day["final_source"], "fugle")
        self.assertEqual(day["limit_queue_samples"], 1)
        self.assertEqual(day["limit_queue_sources"], ["fugle"])
        self.assertEqual(day["fugle_checks"], {"ok": 1, "rejected": {}})
        sc = rep["source_compare"]
        self.assertEqual(sc["ranks"][-1]["top10_overlap"], 1)
        self.assertEqual(sc["ranks"][-1]["fugle_top10_closed_limit"], 2)
        self.assertEqual(sc["ranks"][-1]["shioaji_top10_closed_limit"], 1)
        self.assertEqual(sc["queue"]["paired_samples"], 2)
        self.assertEqual(sc["queue"]["locked_agree"], 1)
        self.assertEqual(sc["queue"]["locked_disagree"], 1)
        self.assertEqual(sc["queue"]["queue_lots_abs_diff_median"], 10)
        with open(os.path.join(out, f"{self.ymd}.md"), encoding="utf-8") as fh:
            self.assertIn("富果 vs 永豐", fh.read())


@unittest.skipUnless(os.environ.get("PREOPEN_NET") == "1", "set PREOPEN_NET=1 for network checks")
class RealEodValidation(unittest.TestCase):
    def test_formula_matches_tpex_next_day_limit(self) -> None:
        raw = json.loads(
            p.http_get(
                "https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/"
                "stk_quote_result.php?l=zh-tw&d=115/10/07&o=json"
            )
        )
        t = raw["tables"][0]
        f = p.field_index(t["fields"])
        checked = mismatched = 0
        bad = []
        for row in t["data"]:
            code = str(row[f["代號"]]).strip()
            if not p.COMMON_STOCK.match(code):
                continue
            ref = p.num(row[f["次日參考價"]])
            lim = p.num(row[f["次日漲停價"]])
            if not ref or not lim or lim >= 9990:
                continue
            checked += 1
            if abs(p.limit_up_price(ref) - lim) > 1e-6:
                mismatched += 1
                bad.append((code, ref, lim, p.limit_up_price(ref)))
        print(f"\nTPEx 次日漲停價核對：{checked} 檔，不符 {mismatched}；樣本 {bad[:5]}")
        self.assertGreater(checked, 500)
        self.assertEqual(mismatched, 0)

    def test_real_eod_loads(self) -> None:
        eod = p.load_eod("2026-10-07", None)
        tse = sum(1 for e in eod.values() if e.market == "TSE")
        otc = sum(1 for e in eod.values() if e.market == "OTC")
        closed = [e for e in eod.values() if e.closed_limit]
        print(f"\n10/07 上市 {tse}、上櫃 {otc}，收漲停 {len(closed)}：{[e.code for e in closed[:15]]}")
        self.assertGreater(tse, 800)
        self.assertGreater(otc, 600)


if __name__ == "__main__":
    unittest.main(verbosity=2)
