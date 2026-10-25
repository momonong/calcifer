# Spike 實作與證據界線

前四節及原「未驗證」清單描述第一輪 characterization 的歷史範圍；2026-10-25 新增的 model POST 持久 intent／UNKNOWN gate、非零 usage 與獨立測試工具結果見末節「Selfhost 離線 boundary」及[本次報告](offline-preparation-report.md)，同版完整驗證35/35通過。真實遠端結果結算與服務窗口仍未驗證。

兩個候選共用 `fixtures/scenarios.json`、相同初始 workspace、`fixture_tool` JSON Schema、最多三次 accepted mock provider requests、同版 Bun 1.4.4，實際 payload 的 max_completion_tokens 皆為512（OpenCode 使用公開 model.limit.output，Pi 使用 model.maxTokens）。腳本耗盡一律拋出 FIXTURE_EXHAUSTED，不生成替代成功回覆。官方 SDK／provider parser／agent loop 真正消費 Chat Completions SSE；只有 provider 網路回覆和工具工作內容是合成 fixture，沒有自寫 agent loop 代替框架。

## 對應 API

OpenCode：`OpenCode.create`、`sessions.create/prompt/wait/export/log/get/interrupt`，persistent SQLite 與 durable events；plugin 使用公開 `session.hook`（prompt/context/model.request/http.request/retry/title/compaction）、`tool.transform`、`tool.hook`。`tool.transform` 移除全部內建工具後，核心仍可新增 CodeMode `execute`；因此 session permissions 設 `*` deny、只 allow `fixture_tool`，實際 payload 驗證只宣告該工具。未知工具在 execute.before 拒絕。compaction auto=false，另設拋錯 hook 防止意外壓縮；摘要保真未測。

Pi：`createAgentSession`、`SettingsManager.inMemory`、`ModelRuntime.create/registerProvider`、官方 `InMemoryCredentialStore`、`SessionManager.create/open`；`DefaultResourceLoader` 不載入 extensions/MCP/CodeMode/skills/context files，只有明列的 inline hooks 與 custom tool。`retry.enabled=false`、`retry.provider.maxRetries=0`，compaction=false、cacheWarming=off；唯一 retry fixture 明確開啟一次 harness retry。終態以 `agent_settled` events 核對。

Pi 的公開 provider request／headers hooks 有做 payload 與 header 標記；兩者出現在實際 mock request。`before_provider_request` 拋錯會被框架捕捉並繼續送出，`hook_throw` 實跑 accepted=1；它不能作硬 gate。OpenCode `http.request` 相同拒絕意圖實跑 accepted=0。兩者都是本輪所用 session HTTP 路徑的窄範圍實證。

## 任務與邊界

| 案例 | 觀察與足夠驗證 |
|---|---|
| text_stop | 跨 byte chunks 的中文文字、stop、完整 stream drain |
| T1 | fragmented tool arguments、官方 tool result 回填、只改 note.txt，sentinel hash 不變 |
| T2 | 先 probe 失敗的 inclusive boundary，再 edit，同一五項 regression 通過；只改 range.mjs |
| T3 | 工具先 append 一次真實合成副作用，再遺失回應；HTTP gate 擋住下一次請求，close/reopen 讀回、未核對前仍阻擋，核對收據後續跑 |
| denied_tool | 模型呼叫未宣告工具，無合成工具執行、無檔案變更 |
| length | fixture 明列 length 及第二個預期 stop 回覆；Pi 只使用第一回，OpenCode 已觀察自動續寫至第二回，即使一般 retry=false |
| truncated / truncated_tool | 串流無 finish_reason，回報原生錯誤／不執行不完整工具，不聲稱遠端未執行 |
| http_error / retry | retry 關閉時503只送一次；唯一明設 retry fixture 503後第二次成功，provider layer 設0 |
| cancel | 收到 mock fetch 後呼叫 interrupt/abort；觀察 abort signal、未 drain、沒有工具開始、遠端狀態 unknown |
| hook_throw | 核對框架 hook 拒絕能否真的阻止進入 mock transport |

T3 計數包含框架 request hook 次數、provider dispatch 嘗試、mock accepted requests、egress gate blocks、append-only `effects.jsonl` 行數與收據。OpenCode 由公開 `http.request` hook 先擋；Pi 由共用的更下層 mock fetch gate 擋。**這是應用政策整合測試，不是框架原生 exactly-once 保證。** clean failed-session close/reopen 已測；硬 crash、上游 at-least-once replay、模型 POST 已送出後的持久 unknown-result ledger、WS 與 locationless generation 均未測，不能從 T3 外推。

## 隔離與證據

worker import SDK 之前移除 provider 環境變數，僅保留 PATH；不重新指定 HOME 或 CODEX_HOME。OpenCode 使用官方 OPENCODE_TEST_HOME 與 XDG 路徑，且拒絕在 `/etc/opencode` 存在時啟動；Pi 使用 empty agentDir 與 in-memory credentials。Node net/tls、Bun.connect、WebSocket 均 fail closed；global fetch 只接受 `https://calcifer.invalid/v1/chat/completions` 並直接回程序內 Response，沒有 DNS 或 remote fallback。

OpenCode 即使 `models.fetch=false`，仍嘗試 localhost 1234、11434、8000 的模型 discovery；三者在 mock fetch 拒絕，accepted=0、socket attempt=0。完整 denied URL 留在各 run，不能將 catalog flag 說成零 discovery 嘗試。

每 run 的唯一 JSON 包含環境、實際套件版本、source baseline、fixture／lockfile SHA-256、所有 synthetic payload、request headers（省略 Authorization）、tool results、原生 events、before/after hashes、changedFiles、取消各層狀態、native finish/error history 與每層 retry 設定。OpenCode 仍額外注入內建 system／skills／環境文字，Pi 仍附 cwd；兩者的 systemChars 與 payload 原文均可核對，不能將它們當同 context 或真實效率比較。

`latest.json` 是索引；測試先執行新 run，再檢查目前 fixtures／lockfile hash、結果、scope、工具宣告與副作用。Node test runner 使用 `--experimental-test-isolation=none`，以免此執行環境的子程序限制遮蔽真正 assertion 輸出。

CLI 僅 `--version` smoke，不等於 CLI task E2E。安裝時 @opentui/core 對 Node>=26.4.0 提出 engine warning；OpenCode SDK 在 Node22 import 出現 `Unexpected identifier '_'`，Bun1.4.4路徑通過。hostRuntimeSdkProbe 記錄實際 runtime 名稱／版本，依 parsed payload 與 exit status 分別記錄 import 失敗或 smoke 成敗；不把其他 Node 版本預設為失敗，其他版本未驗證。這是本輪唯一 runtime 替代，沒有變更全域 Node。

## 第一輪未驗證範圍（歷史）

真實模型自主性、品質、價格／quota、Spark 同源差異、模型 POST unknown-result／crash recovery、running tool 的合作／非合作取消、compaction summary fidelity、正式 UI 與人工接受。mock 的固定回覆不能測出哪個模型更有效率，也不能由合成 usage=0 推算真實費用為0。

## Selfhost 離線 boundary（2026-10-25）

原 characterization 保留；新版由同一 worker 的 `--selfhost` 路徑與 `src/offline-spike.mjs` 執行。兩個官方 SDK 真正產生 request，global fetch 的共同出口先呼叫 `adaptRequest`，再經 `RequestGuard.dispatch`，最後才進同程序 `MockChat`。Pi 的可吞錯 hook 仍不是硬 gate；WebSocket、socket、非 allowlist URL 與 live mode 維持拒絕。

`src/selfhost-contract.mjs` 針對固定 selfhost-models `45ebfd57db5313292ae8f38e733f3e2894a99e5f` 實作文字／工具嚴格子集。只明列轉 `max_completion_tokens`、刪 OpenCode `function.strict=false`、Pi `store=false` 及既定 fixture marker。未知頂層／巢狀 message/tool/function 欄位、衝突 token 欄位、strict=true、未支援能力均拒送；function.parameters 保持服務接受的 JSON Schema dict。檢查精確 model id、candidate context=8192 與 text/stream/tools 能力；不從字元數推論 token context，實際 token 上限仍須服務驗證。

候選 model/revision/context、部署 deadline 上限及 endpoint 均待窗口前現場確認。`deploymentDeadlineMs` 是測試／部署擁有者提供的明確輸入，並非 `/v1/models` 保證回傳的欄位。此次 syntheticSnapshot 只是合成能力資料，沒有發 GET 或 model POST 網路請求。

`src/request-guard.mjs` 在傳輸前 fsync intent；單一 runner 用短生命週期 ledger lock 守併發1。40 次上限跨兩框架共享，每 framework/task 最多6、canary最多2，輸出每次≤512、總預留≤20,480、派送窗口20分鐘；每次 continuation/retry 都必須重新通過 gate，已預留不退款。client 等待上限為服務 deadline＋1秒；中斷／逾時只停止本地等待，不能證明 GPU 停止。非 terminal intent 在重建 guard／子程序重開後仍是 UNKNOWN，改 payload 或 runID 不能清除；無自動 clear/retry/reset。殘留 lock 保守拒絕，不自動刪鎖重送。此為單 runner 保護，沒有多 writer scheduler 或遠端 exactly-once 保證。

回覆最多緩衝1 MiB，檢查 finish、DONE、error frame、工具參數完整性後才把 bytes 交 SDK；缺 DONE、200 error、取消皆保留 UNKNOWN。`length`＋DONE 是已確認模型終止且答案截斷，後續若框架續寫照樣計數。缺 usage 仍為 unknown，另驗非零 input/output/cache usage 經官方 parser。guard 的 `firstByteMs` 從收到 response headers 並開始 drain 時計算，`bufferedCompleteMs` 是同段緩衝完成時間；它們與 SDK 首事件時間、端到端首 token 延遲或原生即時串流速度不同。

新 T1/T2/T3 取共用自然語言 fixtures；read/edit/test/record/receipt 只允許合成 workspace。edit 不代跑 test，T2 單獨測試呼叫留下同五項 red→green。T3 的 model POST 已完成後才發生本地工具收據未知，二者帳本分開；工具收據 reconcile 不能清除 model UNKNOWN。SDK session 保留合成 transcript 到乾淨 close/reopen，隨隔離暫存 workspace 移除；持久 guard 帳本放獨立 evidence 目錄，只保存 hash／metadata，沒有 prompt、完整 response 或 key。新完整 wire/events 證據也僅適用合成 fixtures，不能推及真實資料保存政策。

完整同版驗證、失敗與限制見 [離線準備報告](offline-preparation-report.md)。真實模型自主性、服務恢復、模型 POST 遠端結算、真實斷線恢復、正式 UI 與人工接受仍待確認。
