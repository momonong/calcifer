# Calcifer（卡西法）

目前版本：**0.0.3**（2026-10-30）。完成離線任務契約、自動路由與 M2 的隔離 snapshot 協作、受控工具、持久 UNKNOWN gate、衝突整合及可信 data-only 檔案驗收。10/30 已授權自動路由與協作開發，取代先前人工 profile only 決策；見 [協作計畫](docs/collaborative-development-plan-2026-10-30.md) 與 [M2 契約及限制](docs/milestone-2-isolated-collaboration-2026-10-30.md)。目前是可信 mock worker 的本機原型，一般生成程式的 runtime／unit-test 驗收尚未實作與驗證，不能以本版資料檢查宣稱真實 coding correctness；模型 planner／官方 SDK worker 接線、正式 UI 與 live 仍待後續階段。

工作台 UI 的既有研究提案繼續保留，尚未啟動 UI 實作。背景見 [產品方向與第一版場景](docs/product-direction-2026-10-26.md)、[固定版本上游研究](docs/upstream-workbench-research-2026-10-26.md) 與 [選型決策](decision.md)。

卡西法的最小 OpenCode／Pi harness spike。以固定合成任務與同一組 mock Chat Completions 串流，查核公開 SDK 的接入、工具邊界、重試、取消與 session 讀回。

本輪結論：保留 OpenCode 為條件式主選，Pi 為對照；正式採用所需的真實模型效率與完整 UNKNOWN 恢復仍待驗證。比較表、最小 UI 建議與待決資訊見 [decision.md](decision.md)。

Selfhost 接入的離線準備已加入嚴格 payload adapter、持久 model request intent／UNKNOWN gate、共享 40 次上限與明確候選 profile。服務恢復、ready/models 現場核對與實測窗口仍待確認；正式 UI 繼續暫停。這個 repo 沒有可啟用的 live mode。

目前使用 OpenCode 2.1.4、Pi 1.4.0、專案內 Bun 1.4.4；每個實際 provider request 的輸出上限皆為512。原 characterization 每案最多3次 accepted request；selfhost 路徑每框架每任務最多6次、工具canary最多2次，共用40次上限。Node 22.22.2 用來執行測試與啟動器。本機 OpenCode SDK 在 Node 22 的 import 語法失敗另有保留，實際兩個 harness 都用同版 Bun。啟動器會依實際 host runtime 記錄相容性，不預設其他 Node 版本必須失敗；其他版本尚未測試。

```sh
npm ci --no-audit --no-fund
npm test
# 只產生新一輪結果，不跑 assertions：
npm run spike
# 已先用npm test產生同版characterization收據後，才重跑selfhost子集：
npm run test:offline
```

離線協作路由可獨立重跑，不需要先執行 harness：

```sh
npm run test:collaboration
npm run collaboration:plan -- --plan fixtures/collaboration/plan.json --registry fixtures/collaboration/mock-registry.json
```

CLI 只讀明確指定的 JSON，輸出機讀 JSON；有效計畫 exit 0，壞輸入或任何拒派 exit 1。合成案例包含有相依的 analysis → edit → verify，分給兩個 mock profiles；輸出固定標示 `kind: mock`、`modelRequests: 0`、`executesTasks: false`。framework／model 欄位只是合成 registry metadata，沒有連入真模型、SDK worker 或執行任務指令。

`validateTaskPlan(value, { allowedPaths, allowedCheckIds, maxTasks = 4 })` 接受 `schemaVersion: 1`、非空 goal 與 1–4 個任務；驗證型別、未知欄位、唯一 ID、相依完整性與 DAG，回傳獨立複本。每個任務必須明列 id、instruction、dependsOn、requiredCapabilities、writePaths、checkIds；非空 writePaths 須宣告 edit 能力，非空 checkIds 須宣告 verify 能力。host registry 的 writePaths/checkIds 採精確白名單，路徑須為標準相對檔名，不支援目錄前綴或 glob。registry 由 host 提供，不能接受模型輸出來擴張它。

`routeTask(task, profiles, authorization)` 與 `planAssignments(plan, profiles, authorization)` 只處理已驗證 host 範圍的計畫；它們另檢查結構，但不授予檔案／check 執行權限。只在 enabled、獲 `allowedProfileIds` 授權、mode 符合且滿足全部能力的 profiles 中，以 priority 數值小者優先，再按 ID 字元順序選取，理由列出合格與排除項目。這是明確規則，成本與真實品質仍為 unknown。初版只允許 mock mode；無符合者明確拒派，任一任務拒派會使整份計畫 `assignments: []`，不自動切換付費模型。詳見 [合成 fixture 說明](fixtures/collaboration/README.md)。

M2 固定合成 demo 會真的建立隔離檔案快照，兩個相依任務共同修改文字，來源不變；固定 host node-data check 在 namespace 邊界內檢查整合後的 snapshot JSON：

```sh
node src/collaboration-run-cli.mjs demo --state-root "$PWD/evidence/collaboration-runs"
node src/collaboration-run-cli.mjs reopen --state-root "$PWD/evidence/collaboration-runs" --run-id <returned-run-id>
```

`reopen` 唯讀核對身分、帳本與接受的內容，不恢復派送或清除 UNKNOWN。工具只提供精確 read/search/edit/check；工具入口隨 task 封口；一旦 UNKNOWN，連尚未開始的 queue 都拒絕，未結算工作會阻擋新 run。最終 `host.finalCheckIds` 不受 plan 省略影響。本版只支援可信 `node-data`：僅唯讀掛載 `/input/snapshot.json` 與固定 check script，不掛 worker 可編輯的 executable workspace。check 作者必須把內容當 data，不能對 snapshot 或其衍生字串 eval/dynamic import/exec，也不能插入程式碼模板；模型不能定義 check。input/script/protocol 與 integration manifest 的 hash 綁定證據。先前 node:test 事件完成通路因可偽造已移除，不再支援 legacy `node` check，亦不自動轉換。每筆結果及最終 report.checks 都明列 `kind:'node-data'`。Linux adapter 需要 unshare/bwrap/timeout；不可用就明確拒絕，沒有無隔離 fallback。已驗證 namespace/檔案邊界，CPU/RAM/PID 配額與 seccomp 未證明，不宣稱 production 沙箱。詳細 API、上限與可信 worker 邊界見 [M2 文件](docs/milestone-2-isolated-collaboration-2026-10-30.md)。

`npm test` 會先用官方 SDK 真正跑 mock harness，再用 Node 內建 test runner 核對結果。每次結果寫入唯一的 `evidence/runs/<time>-<id>.json`，`evidence/latest.json` 只保存最新索引與檔案 SHA-256。依賴安裝需要 npm 網路；mock 測試使用程序內 fetch，無 provider 網路需求。

Selfhost 測試另寫 `evidence/runs/offline-<time>-<id>.json`、`evidence/offline-latest.json` 與獨立 `evidence/offline-ledgers/<runID>/`，不覆寫舊 run。每框架一次兩回合工具 canary（read→matching result→final）與 T1/T2/T3 共用同一個持久帳本；錯誤、取消與預算耗盡測試各有隔離的合成 run，不能將它們加總成單一 live run。未完成的 intent 不能藉由換 framework、payload、session、runID 或重開 process 清除；沒有自動解除 UNKNOWN 的入口。

- [更新紀錄](CHANGELOG.md)：本次公開範圍與證據界線。
- [安全重開契約](docs/research/safe-reopen-contract-2026-10-27.md)／[固定原生 API](docs/research/native-reopen-api-map-2026-10-27.md)：觀察與接續分開，維持 UNKNOWN 與原始身分。
- [C1–C8 證據映射](docs/research/safe-reopen-evidence-map-2026-10-27.md)／[機讀摘要](docs/research/safe-reopen-evidence-map-2026-10-27.json)／[設計案例](docs/research/safe-reopen-cases-2026-10-27.json)／[版本證據說明](docs/research/safe-reopen-evidence-2026-10-27.json)：C1／3／4／8 只有部分離線子步驟；C2／5／6／7 無完整實例，八個完整 host 案例執行數為 0。
- [驗證計畫](docs/spike-plan.md)：固定任務、範圍、成功條件與停止條件。
- [實作與證據界線](docs/spike-implementation.md)：實際 API、失敗、重跑方式與未驗證部分。
- [公開驗證摘要](evidence/offline-validation-summary.json)：0.0.0 的歷史 35/35 結果、固定版本、source hashes 與原始收據 hash；原摘要保持原樣。0.0.2／0.0.3 另有新功能驗證與整合測試，舊 package hashes 不能當成本版 hashes。
- [失敗與限制摘要](docs/offline-preparation-report.md)：保留已知失敗、修正及尚未驗證的界線。
- [離線準備報告](docs/offline-preparation-report.md)：本次 adapter、預算、完整測試收據與剩餘窗口要求。
- [候選 profile](fixtures/selfhost-profile.json)／[共用自然語言任務](fixtures/tasks.json)：精確候選參數與待確認狀態。

T1 只修改 `note.txt`；T2 在同一個 `range.mjs` fixture 上記錄五項邊界檢查的 red→green；T3 製造工具副作用已提交但收據回應未知，擋住下一次推論，重開 session 讀回並核對收據後繼續。所有工作目錄都是臨時合成資料，程序結束後釋放。

T3 的收據 ledger 與 egress gate 是本 spike 的本地政策。它不證明框架原生保證 exactly-once，也不涵蓋模型 POST 後結果未知的持久恢復。取消案例只證明 mock client signal 的終止觀察，遠端推論狀態仍為 `unknown`，未啟動的工具不等於已驗證工具中止。

上段是原 characterization 的範圍。新增 selfhost 路徑另驗證 model POST 的持久 intent、程序退出後 UNKNOWN 阻擋及跨框架預算；它只提供保守拒送，沒有遠端工作查詢或 UNKNOWN 結算。新 T2 的 edit 不會代跑檢查，必須明確呼叫 test。SSE 有界緩衝至完整 finish＋`[DONE]` 才交 SDK；缺 DONE／200 error frame 的完整工具參數也不會執行。這改變事件與首 token 時序，不能拿 mock 時間比較原生串流速度。

新 guard 帳本只存 hash、預算、狀態、usage 與 request metadata；原生 SDK session 仍會保存訊息，此測試只使用隔離暫存合成資料並在 worker 結束後移除。完整 wire/events 收據也只有合成資料；不能將這個測試儲存方式直接用於真實資料，或宣稱 SDK 完全不存 prompt。

真實模型品質、速度、費用、配額、Spark 適配與使用者接受都維持 `pending`／`unknown`。scripted mock 的毫秒數與合成零用量僅供工程診斷。CLI 只驗 `--version`。10/25離線階段未操作Git；10/26研究階段另依明確授權交付完成成果至Git，服務與部署仍未啟動。歷史收據與階段報告保留原狀，發布範圍見 [公開交付與證據政策](docs/publication-notes-2026-10-26.md)。

公開repo只保存由既有證據擷取的摘要。重跑會在本機產生完整合成raw receipts與ledger，已由.gitignore排除；沒有對真實資料做通用去敏，請勿直接公開這些輸出。原始收據及歷史中間run另保留本地，公開摘要不是完整trace或新的測試執行。

新checkout請先跑 `npm test`。`test:offline` 的payload契約測試需要既有同版characterization收據；若只準備子集，先執行 `npm run spike` 再執行 `npm run test:offline`。
