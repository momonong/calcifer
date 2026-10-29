# 卡西法：自動路由與協作開發計畫

> For agentic workers: execute the approved milestones in order, using the project's bounded verification rules. The implementation owner may use the relevant Superpowers workflow; user authorization and preservation rules take precedence over skill defaults.

**Goal:** 把單一開發目標拆成有界任務，在已核准模型 profiles 內自動分派，隔離執行並整合驗證後交付。

**Architecture:** OpenCode 維持主要 coding harness，Pi 保留對照。薄型本機 host 承接任務圖、可解釋路由、操作範圍、全域資源及結果整合；不重寫底層 agent loop。初版先以注入式 mock planner/worker 驗證協作契約，再接官方 SDK 的離線 transport。

**Tech Stack:** Node 22、JavaScript ESM、node:test、固定 Bun 1.4.4；OpenCode 2.1.4／Pi 1.4.0。沿用現有 lockfile，不新增依賴，除非必要且說明理由。

**Spec / authorization:** 使用者於 2026-10-30 要求自動路由、目標拆任務、分配與協作後交付，取代先前只可人工選 profile 的決策。已授權開始開發，於當日 Asia/Taipei 12:00 停止並交付，每個可驗收增量提交、合併與推送。正式 UI 仍暫停；服務恢復和 live 窗口尚未授權。既有 40 次生成上限不擴張為多模型新額度。原本三任務同模型比較仍保留，協作原型另標離線證據。

## Global Constraints

- 自動路由只能在 host 提供、已核准的 profile 清單內選擇。模型輸出不能新增 endpoint、credentials、額度、工具或寫入路徑；任何付費 fallback 均禁止。
- 新規格取代人工 routing only，沒有取代 UNKNOWN 不重送、最小驗證、保留歷史、服務/UI/Git範圍界線。
- 初版每個目標最多 4 個任務，圖不得循環、重複 ID、缺相依或越權。這是首版產品限制，沒有宣稱是最佳分解數。
- 協作先單一模型請求併發；工作區與產物各自隔離。可使用多個 mock profiles 證明路由，不宣稱多個真模型已接入。
- Planner/worker/verifier 的任何實際生成，都必須計入同一授權及持久帳本；UNKNOWN 不因換任務、模型、session或重開消失。
- 工具只接收已登錄命令ID與被允許的相對路徑。完整 JSON/schema 驗證在本機執行；模型說成功不能當驗收。
- 初版不訓練、不下載模型、不啟停服務、不調用未核准端點。Codex 蒸餾先評估資料及授權；不保證能複製教師能力。
- 只公開本目標程式、必要文件、合成 fixtures 與欄位白名單證據。原始帳本、session、完整聊天、憑證、私人端點、本機路徑及無關WIP不入Git。
- 使用現有隔離worktree與功能分支；Git交付由原目標對話做。tag/release、部署及清理不包含在本次授權。

## Milestone 1 — 任務契約與可解釋路由（目標版本 0.0.2）

Files: 新增 `src/task-plan.mjs`、`src/model-router.mjs`、`src/collaboration-cli.mjs`、`fixtures/collaboration/`、`test/task-plan.test.mjs`、`test/model-router.test.mjs`；更新必要的 README、CHANGELOG 與 package scripts/version。

Interfaces:
- `validateTaskPlan(value, { allowedPaths, allowedCheckIds, maxTasks = 4 })`: 驗證 JSON plan 並回傳獨立的合法值。plan 含 schemaVersion、goal、tasks；task 含 id、instruction、dependsOn、requiredCapabilities、writePaths、checkIds。不得默默丟棄未知權限欄位。task與goal不可空白；驗型別、ID唯一、相依存在、DAG、路徑/check授權。
- `routeTask(task, profiles, authorization)`: 回傳 profileId 與可稽核選擇理由；沒有符合者回傳明確拒派。profile含id、framework、model、capabilities、priority、enabled、mode；authorization至少指定 allowedProfileIds 與 mode。只依明確能力及穩定priority/ID排序；不聲稱已最佳化成本。
- `planAssignments(plan, profiles, authorization)`: 產生完整路由計畫；任一必要任務不可派送時，整份計畫不得悄悄缺漏。
- CLI 接收明確 JSON plan 與 mock registry，輸出機讀路由結果或明確錯誤；此階段不發網路、不生成模型內容、不執行程式。

- [x] 先寫出關鍵失敗案例：循環、未知依賴、重複ID、超出4任務、越界路徑、不在host清單的check/模型、缺能力、重排registry仍穩定、完整路由不可部分成功。
- [x] 實作最小契約與路由，不導入通用policy DSL或機器學習router。
- [x] 用兩個mock profiles及有相依的analysis/edit/verify任務展示不同分派，明記mock來源；CLI壞輸入有非零exit。
- [x] 跑新功能定向測試與一次整合套件；報告真實計數及未測範圍，更新使用說明與版本。
- [x] 原對話核對diff、必要風險審查後，白名單提交、PR、合併與核對remote main。舊0.0.1研究commit保留並明列在首次交付範圍。

## Milestone 2 — 隔離協作與整合驗收（目標版本 0.0.3）

M1（0.0.2）已完成審查、PR 合併與 remote main 核對。M2 細化介面及安全邊界見 [M2 契約](milestone-2-isolated-collaboration-2026-10-30.md)；最終驗收由 host.finalCheckIds 固定，單任務仍可使用。

- [x] 薄runner只派送相依已完成的任務；各worker有隔離工作目錄，產物帶基線hash與允許的變更集合。
- [x] 相同檔案衝突不得最後寫入者覆蓋；有相依的任務讀到已核對前置成果。無關工作保留，未通過的patch不進整合結果。
- [x] 增加受控讀/搜尋/原子編輯/已登錄check工具；阻擋路徑穿越、symlink逃逸、過期版本、任意命令及不完整tool參數。
- [ ] 一般生成程式 runtime/unit-test 驗收尚未實作/驗證（能力 pending，非缺授權 blocked）。本版只驗可信 node-data；OS namespace probe 不代表一般 runtime correctness 已完成。
- [x] 固定task/workspace/profile/ledger身分；缺帳本、未知結果與尚未結算副作用fail closed，唯讀重開不恢復派送。
- [x] 合成兩任務共同完成一個修改，最終integration checks對應整合後最新hash；失敗、衝突、取消與UNKNOWN有明確結果。
- [x] 交付可重跑CLI、必要回歸證據與版本，不宣稱模型自主拆解能力。

M2 原 54/54、89/89 與首輪修正後 12/12、2/2、1/1 保留為歷史。UNKNOWN admission 已修；node:test 事件路徑仍可偽造，已移除，正式改為可信 data-only 合同；最後只補受影響的 6/6 及 CLI/legacy-kind 2/2（exit 0、0 fail/skip），未重跑全套。上述 runtime 能力 pending 不由 M3 補上；M3 只證明官方 SDK/路由/協作/檔案資料驗收整合，真實模型服務授權另缺。公開 Git 交付待原目標對話核對。

## Milestone 3 — 官方 harness 接線與交付閉環（目標版本 0.0.4）

- [ ] Planner可注入，從goal取得結構化TaskPlan後先驗範圍再route；mock生成的plan始終標明mock。不得由自然語言直接授予新權限。
- [ ] OpenCode/Pi worker透過官方SDK和既有mock transport進入相同任務/工具契約；不以自寫agent-loop冒充官方harness。
- [ ] 實際wire記錄總system/context、工具與thinking參數。來源版本固定，adapter只做明列轉換，不依一般OpenAI-compatible宣告。
- [ ] 規劃、執行、必要驗證共用全域授權/額度；保持單一模型請求併發，續寫亦計數。完成後不得多開review模型回合。
- [ ] 最終報告包含目標、任務分派、diff、相關驗證、失敗/未完成、人類介入及usage unknown；工程完成與人工接受分開。
- [ ] 只有服務窗口、模型revision/parser、資料與資源均已確認才做live；否則交付完整離線能力及精確pending清單，不以合成結果假報真能力。

## Review Focus

1. 不可信plan或profile試圖擴張writePaths/checkIds/模型權限，必須在派送前拒絕。
2. UNKNOWN、缺失帳本、重開與換模型不能重新開始預算或重複副作用。
3. 合法單任務結果不代表整合版本已驗收；衝突與過期證據必須擋住完成。
4. child process、工作目錄與Git worktree不是OS安全沙箱；執行隔離證據分開記錄。
5. mock planner/worker/schema成功不代表開源模型能自主分工或修對程式；報告必須保留provenance。

## 進度與停止

本文件為2026-10-30的開發規格，取代先前不做自動路由/協作的相關段落。現有研究頁保留為歷史，下一次說明需呈現修訂。原始實測40次、每次512 tokens、每框架任務最多6回合及20分鐘派送窗口保持原約定；協作live若需不同預算需另行確認，不能挪用成無界多模型工作。

每個milestone一份具體成果與版本；有新變更/失敗/風險才補驗，不機械重跑。達標可提前停止，時間上限不是工作量目標。截止時保存成果、核對Git交付、列出限制並直接回報，不用新功能填滿剩餘時間。
