# 卡西法：OpenCode／Pi 小型驗證計畫

狀態：2026-10-25 本輪可取得的離線驗證與選型建議已交付，待使用者確認；正式 UI、真實模型與 Git 發布未執行。結果見 [decision.md](../decision.md)。

## 目標與界線

以 OpenCode 為預設主選，核對固定基線並用相同的合成任務與 mock Chat Completions fixture 驗證必要接入能力。判斷是否有足以改選 Pi 的證據；不將 scripted mock 的正確性、速度或 token 數宣稱為模型工作效率。

- OpenCode：`anomalyco/opencode`，`v2.1.4`，`68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`。
- Pi：`earendil-works/pi`，`v1.4.0`，`4a080252f06caf63a525d7873c5d94d3c23887e0`。
- 起點：乾淨 `main`，`82a0ec1a2e9a395dfdd521f30e4c6c41997ab451`；工作分支 `feat/harness-spike`。
- Node.js 22.22.2、npm 10.9.7、Linux；鎖版 npm 依賴與 lockfile。OpenCode SDK 在 Node22 匯入失敗後，唯一 runtime 替代為上游固定基線使用的專案內 Bun 1.4.4；兩框架都用同版 Bun。現有 README 保留其專案名稱並補入口。
- 僅合成資料、無真實憑證、無遠端推論。SDK 測試使用 in-process mock fetch 或測試期間存活的 loopback fixture；不接入既有服務。
- 一位 Sol 6.1 Ultra 承接程式／測試／必要文件；兩位唯讀研究者分查官方來源，父代理核對決策。共用工作目錄只有一位寫入實作者，不新增 worktree。

## 可觀察成功條件（先於測試固定）

| 任務 | 必要結果 | 足夠的驗證 | 不應發生 |
|---|---|---|---|
| T1 小修改 | 只改指定字串或小函式 | 目標輸出檢查、檔案範圍 diff | 無關重構、全專案掃描 |
| T2 bug | 先重現固定失敗，修正邊界，再通過相關回歸 | 同一小測試的 red→green 與非目標檔案雜湊 | 跳過失敗重現、重寫測試掩飾問題 |
| T3 中斷／恢復 | 保留已知狀態，遇未知結果停止自動重送，核對收據後恢復 | 固定 operation ID 的副作用計數、session／事件與恢復後結果 | 重新執行未知工具造成重複副作用 |

實測框架若無法在本輪安全跑完，保留失敗與限制；獨立 fixture 通過不能代替 framework E2E 通過。真實 agent 是否能自主改變假設、停止及減少人類介入，須由後續相同模型的授權試驗回答。

## 實作與驗證

1. 核對官方版本／套件／近期修復，安裝明確版本；來源不可取時最多一次有因的替代查核，保留缺口，不改 latest。
2. 建立最小 fixtures：文字串流、分段 tool arguments／工具回填、正常 stop、length、不完整串流、HTTP error、取消、未知結果／session 恢復。觀察 transport／SDK／harness 重試層，分開使用者停止等待、stream drain、工具停止與遠端狀態。
3. 官方 SDK／CLI 各執行最小 smoke，記錄公開設定／API、experimental 或核心 patch。相同任務使用相同初始 workspace、工具能力、mock 回覆與預算；記錄框架額外 context。
4. 用 Node 內建 test runner 執行相關測試，產生可重跑的精簡 JSON 證據；資料無法取得時用 `unknown`／`pending`，成本不得默認零。
5. 彙整比較、失敗、維護成本、Spark 待驗證條件與 `decision.md`；由父代理做一次聚焦整合核對。僅新增變更或明確疑慮才重跑相關測試。

## 有界規則

初始研究以約 15 分鐘／候選為目標；實作集中一輪最小接入，遇同因連續失敗兩次即改假設，第三次無進展保留該案例未完成。每個 mock run 最多 30 秒、三個模型回合（需重現 retry 的案例另設明確上限），禁止永久服務、付費 fallback 或大模型下載。必要局部修正可做，不能以研究困難為由降低驗收。

完成本輪可取得的離線證據及建議即交付；真實模型、Spark、正式 UI 與上游升級維持 pending，等待使用者下一階段決策。

## 收束紀錄

- 24 個官方 SDK mock 案例（每框架 12 個）；13/13 測試通過。真實模型品質／自主工作效率未執行，成本 unknown。
- 最終固定每次輸出上限 512；兩框架實際 payload 已核對。額外 context 如實保存，不強迫內部相同。
- 唯一整體 review 找到三項 P2：腳本耗盡被補成成功、輸出 cap 不一致、host runtime 誤固定為 Node22。一次修正後做局部確認，三項皆已處理，未再擴張檢查。
- 原始最終收據與早期失敗、不等預算run保留本地；公開repo只提供 [衍生驗證摘要](../evidence/offline-validation-summary.json)，不包含raw trace。
- T3 只覆蓋合成工具未知結果與 clean session 重開；模型 POST UNKNOWN、硬 crash、執行中工具取消、摘要保真及 Spark 實機仍 pending。
- 無核心 patch、無正式 UI、無真實模型呼叫；無 commit／push／merge／發布／部署。原工作分支與未提交成果保留。
