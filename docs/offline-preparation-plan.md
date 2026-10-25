# Selfhost 離線接入準備 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 執行這個相依性緊密的工作項目；原目標對話負責整合核對。使用者的有界驗證、既有目錄與不提交要求優先於技能預設。

**Goal:** 補齊兩個固定 harness 接入 selfhost-models 前的離線缺口，保留 OpenCode 主選，等待服務與實測窗口。

**Architecture:** 沿用官方 SDK 與既有 in-process mock，新增小型共用 contract adapter、持久 request guard 及明確 profile。所有可執行驗證維持離線，沒有自動路由、服務管理或真實推論入口。

**Tech Stack:** 現有 Node test runner、Bun 1.4.4、OpenCode 2.1.4、Pi 1.4.0；不新增依賴。

**Spec:** 本對話使用者於 2026-10-25 明確同意最小實測方案與 40 次生成上限，要求「先補齊離線缺口」、「服務恢復與實測窗口另行確認，不要自行啟動」、「正式 UI 繼續暫停」。原驗收與證據界線見 [spike-plan.md](spike-plan.md)、[decision.md](../decision.md)。

**執行狀態：** 離線實作與同版完整測試35/35已完成，精確收據與hash見 [offline-preparation-report.md](offline-preparation-report.md)。原目標對話正在做最後限定核對；服務恢復、現場模型與窗口確認、真實40次生成及正式UI均未啟動。本計畫以下checkbox保留最初驗收清單，實際完成證據以報告為準。

## Global Constraints

- 沿用 `feat/harness-spike@82a0ec1a2e9a395dfdd521f30e4c6c41997ab451` 的既有未提交成果；只有一位實作者寫入，不建立 worktree，不提交／推送／合併／發布。
- 不讀真實憑證、不發 metadata 或推論網路請求、不啟停服務、不下載或切換模型、不修改 selfhost-models。
- 契約固定於 selfhost-models `45ebfd57db5313292ae8f38e733f3e2894a99e5f` 的 `docs/client-integration.md`、`docs/api.md` 與 `selfhost_models/schema.py`；現場版本／模型仍須窗口前核對。
- 預定實測：2 frameworks × 3 tasks × 最多 6 requests + 每框架 2 次接入探測 = 40 次生成；每次輸出 512，總預留輸出 20,480；併發 1、派送窗口 20 分鐘、服務 deadline ≤30 秒且不得超過現場上限。所有續寫、重試或隱含生成均計數，普通 retry 關閉。
- 只允許合成資料、明確設定檔及受控工具；不自動選模或 fallback。預算同意不代表已確認執行窗口。
- 不把 scripted mock 當模型自主能力，不把等待逾時／取消當遠端終止，不把缺 usage 當零成本。

## Review Focus

- 未知或衝突的 provider 欄位／巢狀工具欄位必須拒絕；只明列已知轉換，不吞掉任意未知參數。
- 已有 finish_reason 但無 `[DONE]`、HTTP 200 error frame，均不得交付成功或執行其中工具。
- request 送出前保存 intent；失聯／中斷後，新 process 或新 payload 不能繞過同 run 的 UNKNOWN 阻擋。
- 40 次總額、task/canary 子額、時間與單請求輸出限制在傳輸前檢查；重新開啟不得重置帳本。
- 已完成模型 POST 與未知本地工具副作用分開；usage、SSE drain、client stop、tool state、remote state 不混為成功。

## Task 1: 可重跑的離線接入邊界

**Files:**
- Create: `src/selfhost-contract.mjs`（profile/schema 轉換、SSE 完整性與 usage）；`src/request-guard.mjs`（本輪單 runner 的持久 intent／budget gate）。局部命名可由實作者調整並記錄。
- Create: `fixtures/selfhost-profile.json`（明確待確認的端點／模型、固定參數、授權上限、window pending）、`fixtures/tasks.json`（自然語言任務／驗收／初始 workspace）。
- Modify: 既有 `src/worker.mjs`、`src/spike.mjs`、fixtures 與 tests，讓官方 SDK 確實走新增 boundary；可選最小獨立 offline worker，不廣泛重構。
- Modify: `README.md`、`docs/spike-implementation.md`、`decision.md`，保存本輪證據與剩餘窗口要求。

**Interfaces:**
- adapter 接受 framework 實際 payload 與固定 profile／合成 capabilities snapshot；輸出 selfhost 嚴格子集及已套用的轉換名稱，不記錄秘密或任意內容。
- request guard 在可注入的離線 transport 前保留 intent；收到可驗證 terminal 才結算；UNKNOWN 沒有自動清除／重派介面。保留單 runner 範圍，避免通用 scheduler。
- test transport 只用 in-process fixtures；live mode 不可啟用。保留原始 characterization 證據，新增結果清楚標記 adapter 後行為。

- [ ] 先增加能重現實際缺口的測試並記錄失敗：max_completion_tokens→max_tokens；OpenCode function.strict=false 移除、Pi store=false／fixture marker 明列處理；其他未知／衝突欄位拒送；exact model／context／tools 能力驗證。
- [ ] 實作最小轉換與設定檔。現有 mock context 32000 不可沿用到候選 profile；8192 只作待確認候選，現場必須匹配。持有 strict=true 或未支援能力不得靜默降級。
- [ ] 補獨立 SSE cases：正常文字與 tool arguments、finish 無 DONE、200 error frame、missing usage 與非零 usage、取消／中斷。若為避免不完整 stream 的工具副作用而有界緩衝回覆，明記對 first-token／事件時序的影響，不冒稱端到端即時串流已驗證。
- [ ] 實作並驗證持久 request intent／UNKNOWN gate 與 40 次共享預算；包含重新建立 guard／子程序重開、改 payload 仍拒送、已知完成可以進下一回合、budget/time exhaustion 在 dispatch 前拒絕。紀錄不存 prompt／完整 response／key。
- [ ] 準備共用自然語言 T1/T2/T3 和受控 read/edit/test/receipt 能力。edit 不自動代跑測試；T3 的本地合成失敗／安全 session 邊界與模型 POST UNKNOWN 測試分開。測試成功不代表模型會自主選對工具或有效調整假設。
- [ ] 兩框架各跑必要官方 SDK mock 案例，證明 payload adapter、SSE guard、UNKNOWN 與 budget gate 接上實際 request path。沿用充分舊證據，只有受影響範圍重跑。
- [ ] 保存不可覆寫的測試收據、source/profile/fixture/lockfile hashes 與必要失敗紀錄。更新使用方法及 decision：OpenCode 保留主選、明確 profiles、live window pending、UI 暫停。
- [ ] 原目標對話核對實際 diff 與同版證據，針對具體缺陷修正後只重驗受影響部分；通過即停止，不另加全專案 review。

## 完成與停止條件

本輪交付離線 adapter／fixtures／tests 與可重跑命令；不消耗已批准的 40 次真實生成。若公開介面無法守住邊界，保存具體失敗與剩餘限制，不以測試 transport 掩飾原生行為，也不改核心或擴張成平台。服務恢復、現場模型核對、實測窗口與正式 UI 仍須後續確認。
