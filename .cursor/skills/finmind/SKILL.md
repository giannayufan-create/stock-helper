---
name: finmind
description: >-
  Query Taiwan market data via FinMind (prices, institutional chips, monthly
  revenue, financials, broker branches). Use when the user asks for FinMind
  data, 台股股價/法人/營收/財報/分點, or when wiring broker-intelligence.
  Prefer FinMind MCP tools over raw HTTP. Never mutate A/B/C/BP/Rank engines.
---

# FinMind Agent Skill（本專案）

官方 Agent Skill 來源：https://finmindtrade.com/analysis/#/data/ai_agent_skill  
詳細指令參考：同目錄 `finmind-command.md`（FinMind 官方 `/finmind` 命令檔）。

## 何時使用

- 使用者問台股股價、三大法人、融資融券、月營收、財報、股利、分點
- 開發／除錯 `broker-intelligence`、FinMind provider、籌碼背景
- 需要對照 FinMind dataset 名稱與會員層級（Free / Backer / Sponsor）

## 優先順序（本專案）

1. **已啟用 FinMind MCP 時**：直接呼叫 MCP 工具（`user-finmind`）
   - `get_stock_info` — 代號／名稱
   - `query_dataset` — 通用 `/api/v4/data`
   - `query_trading_daily_report` — 券商分點（需 Sponsor）
   - `list_datasets` — 資料集清單
2. **沒有 MCP**：依 `finmind-command.md` 用 Python `requests` + Bearer token
3. **Token**：Cursor MCP 用 `FINMIND_TOKEN`；Render／本專案後端用 `FINMIND_KEY`（同一個 FinMind token，不是 FinImpulse）

## 與「股市小幫手」的關係

| 能力 | FinMind Skill / MCP | 本系統盤中雷達 |
|---|---|---|
| 日線股價／法人／財報查詢 | 強 | 已有 TWSE 籌碼等來源 |
| 券商分點（盤後） | Sponsor | `broker-intelligence` + `FINMIND_KEY` |
| 盤中 tick／五檔／B／C | 不取代 | 永豐 Shioaji／Fugle |
| 自動改 A／B／C 門檻 | **禁止** | Outcome／shadow 僅研究 |

**硬規則：** FinMind 資料只當 context／研究／分點顯示。**Never mutates A/B/C / Buy Pressure / Rank / Radar scores.**

## 常用意圖 → Dataset

| 意圖 | Dataset | 層級 |
|---|---|---|
| 股價 | `TaiwanStockPrice` | Free |
| 三大法人 | `TaiwanStockInstitutionalInvestorsBuySell` | Free（要 data_id） |
| 融資融券 | `TaiwanStockMarginPurchaseShortSale` | Free |
| 月營收 | `TaiwanStockMonthRevenue` | Free |
| 券商分點 | `TaiwanStockTradingDailyReport` / SecIdAgg | **Sponsor** |
| 分 K／Tick | `TaiwanStockKBar` / PriceTick | Sponsor |

## 輸出

- 表格為主；比較／走勢可摘要中文結論
- 權限不足（Sponsor）時據實說明，不要捏造分點名稱
- HTTP 402：額度用完；400 Token illegal：提醒換 FinMind token（非 FinImpulse）

## 使用方式

在 Cursor 輸入例如：

- 「用 FinMind 查 2330 近一週三大法人」
- 「台積電今年月營收」
- 「2330 昨天券商分點」（需 Sponsor）

或明確叫用：`/finmind`
