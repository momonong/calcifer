# OpenCode／Pi 工作台接入研究

查核日期：2026-10-26（Asia/Taipei）。本次只有官方公開資料查核與此文件寫入；沒有安裝依賴、執行測試、模型呼叫、服務啟動或 UI 實作。產品方向與最終選型由目標負責對話決定；OpenCode 保留主選。

## 結論與版本界線

**現有證據支持以 OpenCode 作工作台的執行核心，沒有理由因「新版已修好恢復」而改變既定安全邊界。** 直接使用上游 UI 可省去通用介面維護；自建薄工作台的理由應是 Calcifer 特有的工作狀態、授權、預算與 UNKNOWN 處理。Pi 可以嵌入，但需由產品承接更多工作台與權限整合。這是架構推論，不是模型品質或產品使用驗收。

| 對象 | 本次官方核對 | 與已測版本的差異 |
| --- | --- | --- |
| OpenCode **產品 v2** | 官方 changelog 最上方為 **2.1.4，2026-10-23**；Git refs 中最高 v2 tag 為 `v2.1.4`，解析為 `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824` | 與已測 `@opencode/sdk`／`@opencode/plugin`／`@opencode/cli` 2.1.4 相同；本次未找到更新的正式 v2 修復。[S1] |
| Pi | 官方 latest release 為 **1.4.0，2026-10-21**；`v1.4.0` 解析為 `4a080252f06caf63a525d7873c5d94d3c23887e0` | 與已測 `@earendil-works/pi-coding-agent`／`pi-ai` 1.4.0 相同。[S2] |

未盤點未發布分支，不把後續 main／開發分支變更當成已可用修復。已測版本內值得保留的變更：OpenCode 2.1.4 修正 MCP elicitation 在桌面／web 的顯示與 compaction 邊界，新增 experimental client MCP 連線；2.1.3 已修正 custom baseURL 優先序。Pi 1.4.0 已修正 resumed extension tools、截斷 tool-call 後的 transcript、compaction 輸出上限與若干 retry 判定。這些是版本說明，不能擴張成 Calcifer 已驗證全部能力。

**文件版本陷阱已實際確認：** GitHub `releases/latest` 對 OpenCode 回傳 v1.19.4；`opencode.ai/docs/sdk` 及固定 repo 中 `packages/web/src/content/docs/` 仍是 v1 文件，使用 `@opencode-ai/sdk`。其中 `@opencode-ai/sdk/v2` 是該套件的 client 子路徑，不能據此視為產品 v2。產品 v2 的文件位於 `/v2/`，固定 repo 來源在 `services/www/src/docs/content/`；套件為 `@opencode/sdk`、`@opencode/client`。本文件的 v2 能力只引用後者及同 commit source。

## OpenCode 可直接使用的邊界

| 需求 | 已存在的介面／行為 | 工作台仍需負責 |
| --- | --- | --- |
| 嵌入 runtime | `OpenCode.create()`（`@opencode/sdk`）建立 in-process host，HTTP router 在記憶體執行，不開 listener；`sessions`／`events` 是生成 client 的方便別名；支援啟動 plugins、`plugin()` 及 `close()`。[S3] | host 生命週期、明確設定／資料位置。瀏覽器不能因為有 SDK 就直接取得本機 runtime；需要選擇受控 host 或既有 server。 |
| 連現有 server | `OpenCode.make({baseUrl,headers,fetch})`（`@opencode/client`）；瀏覽器可用的 client 不含本機 process 管理。`Service.discover()` 只尋找既有健康服務；`Service.ensure()` 可能啟動服務。[S4] | 不把 ensure 放進唯讀「檢查連線」；認證、server 選擇與啟動授權要明確。 |
| Session 與完成狀態 | `session.create/get/list`；`session.prompt` 是持久 admission，除非 `resume:false`，否則排入執行；`session.wait` 等待 agent loop idle。另有 inbox、context、diff、fork、form、permission 介面。[S4] | admission、模型結果、工具結果、idle 與任務驗收分開。`context` 是最近 compaction 後的 active context，不是完整歷史。 |
| 前端即時進度 | `event.subscribe()` 為 live-only；無 replay、無自動重連。來源失敗結束訂閱，稍後新訂閱只取得目前 connected marker，不補舊 business events。[S4] | 顯示連線／過期狀態，重連後讀回權威狀態；不能看到串流斷線就重送 prompt。 |
| 可讀回的事件紀錄 | `session.log({sessionID,after,follow})` 讀取 experimental durable session events；`after` 為 exclusive aggregate sequence，`follow:true` 接續 live。另有完整 projected transcript export，但也是 experimental。[S4] | 保留 cursor／去重與版本相容層；不要把 durable session events 當成所有 token delta 都可重播。snapshot 與 log 的無縫同步、斷線競態尚未在本專案驗證。 |
| 權限／提問 | session permission list/get/reply；form list/get/reply/cancel；權限規則用 `permissions:[{action,resource,effect}]`，包含 `shell`／`subagent`。[S4][S5] | reconnect 後重新查詢 pending items；展示批准範圍與持久性。這些 API 不是任意外部操作的統一授權／冪等服務。 |

固定 API source 中，`session.wait`、`session.log`、import/export 的路徑明列 experimental；session／permission groups 也有 experimental 描述。可用不等於長期相容承諾，薄 adapter 應保留版本釘選，升級只驗受影響契約。

## 恢復、資料及權限不能保證的事

- **持久化不等於不重送。** SDK 預設 DB 在記憶體；指定 `database.path` 才跨 host 保留。SDK 啟動會自動 `resumeSuspendedSessions`。固定 restart source 明載 recovery 是 **at-least-once**，本地協調只能防止同時 drain，不能避免 crash 後外部副作用重複。[S3][S4]
- **重建 UI 狀態與恢復執行是兩件事。** 查 session／log 可恢復畫面，不能證明遠端模型未執行、外部工具未成功，亦不能授權重新產生。現有 Calcifer request guard 與本地 tool receipt 應保持各自用途；本次沒有新增其驗證證據。
- **薄前端無法單獨保證模型外送限制。** 若實際 runtime 在上游 server，provider request／工具執行也在該端；只在瀏覽器攔 prompt、顯示預算或監聽 events，無法控制 server restart／內部續寫。此為執行位置推論：Calcifer 的限制須位於確實擁有派送權的 runtime／transport 邊界，不能因換 UI 而遺失。
- **session metadata／SDK instances 不是租戶隔離。** 官方 SDK 說明指出 instance selection 不構成 authorization 或 storage-isolation boundary；不同工作目錄／metadata 不能冒充程序、檔案或秘密隔離。[S3]
- **權限規則不是 OS sandbox。** v2 shell 仍有 host user 的檔案、process、網路權限；command directory inference 是 best effort。預設 base policy 很寬，`external_directory` 預設不詢問；自訂 subagent 使用自身權限，不是父 agent 權限的子集。[S5]
- **Allow always 有持久影響。** v2 的 saved approvals 是 project-scoped、持久的 allow，不能覆蓋 configured deny。`reject` 會拒絕該 session 其他 pending permissions。工作台需要呈現實際範圍，不能把 always 畫成僅本次批准。[S5]

## 現成 UI／remote 與 Pi 的具體取捨

OpenCode v2 內建 web UI 與 TUI 使用同一個 server，預設有密碼保護。`opencode pair` 連結單次、5 分鐘到期；瀏覽器取得 30 天 session cookie，變更 server password 使 session 失效。官方提供 SSH port forwarding，以及明確啟用的 `pair --remote`／OpenTunnel；`serve` 則在前景執行相同 server。[S6] 這證明上游有現成連線流程，不代表已驗證本專案的遠端部署、不同使用者隔離、手機體驗或認證整合；本輪未啟用任何一項。

| 路徑 | 可以少做什麼 | 必須承接／適用條件 |
| --- | --- | --- |
| **薄工作台＋OpenCode** | 重用 agent loop、session、tools、permissions、diff、forms；採 network client 或嵌入 SDK，而非另造 coding runtime | 只做有差異的任務／授權／UNKNOWN／預算視圖；承接事件重連、權威狀態讀回及 runtime 邊界。這是保留主選時最直接的候選，尚非 UI 實作決定。 |
| **直接使用上游 OpenCode UI** | 通用 chat、session 管理、terminal、diff、approval/form 與配對流程由上游維護 | 適合先確認原生流程是否已滿足需求；但未證實它能完整呈現 Calcifer 的持久 UNKNOWN 與共享預算語義，也不能視為已接上既有離線 guard。若原生流程足夠，自建外殼的收益需另外成立。 |
| **Pi SDK／RPC＋自建工作台** | SDK `createAgentSession` 可直接控制 session／model／tools；RPC 提供長駐 JSONL 子程序邊界，可用不同前端語言 | 需建立 server／認證／遠端連線／前端狀態整合；官方 RPC 是 stdin/stdout，不是現成網路服務。SDK SessionManager 是 finalized context 的權威；runtime replacement 後要重新綁 subscription。[S7][S8] |

Pi SDK 的 `prompt()` 會等本次 run（含自動重試）結束；RPC prompt 的成功回覆只代表已接收、排隊或處理。`agent_end` 後仍可能接續恢復與排隊工作；`agent_settled` 才表示不會再自動接續，`message_end` 提供權威完成訊息。RPC commands 可帶 correlation ID，但 session events 通常沒有 command ID；官方要求 client 自行處理 process exit、取消與 deadline。[S7][S8] 未找到可據以宣稱自動網路 reconnect、持久 event cursor replay 或模型 exactly-once 的契約。

Pi 可在 `tool_call` return `{block:true,reason}`，其 handler failure 也會阻擋工具；active tool set 主要表示對模型宣告的工具，不能單獨視為權限撤銷。Extensions 與 Pi 同 process、同 OS 權限；RPC 能轉送支援的 dialogs／notifications，但不能呈現任意 TUI custom components。[S8] 因此「Pi 更小」不能直接推導「工作台較少工程」或「更安全」。

## 決策前仍待證實

1. 哪些 Calcifer 專屬流程是上游 UI 無法清楚表達的；先限定到任務狀態、授權範圍、UNKNOWN／預算，不擴成通用平台。
2. 選用受控 embedded host 或受控 upstream server，哪一端承接已存在的 outbound gate；瀏覽器 UI 本身不作最終安全邊界。
3. 實際 session reconnect／cursor reconciliation、完整 native restart／RecoverFull、權限與原生 UI 整合尚無新增驗證。既有離線成果、未執行的真模型窗口與 UI 暫停狀態均保持原界線。

## 八組關鍵官方來源

以下 OpenCode source 固定 `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`，Pi source 固定 `4a080252f06caf63a525d7873c5d94d3c23887e0`；日期與 latest 查詢為上述查核日的觀察。

- **[S1] OpenCode 版本**：[官方 changelog](https://opencode.ai/changelog)、[v2 tags API](https://api.github.com/repos/anomalyco/opencode/git/matching-refs/tags/v2.)。`releases/tags/v2.1.4` 回 404，因此以官方 changelog＋實際 tag ref 核對，不用 v1 latest 替代。
- **[S2] Pi 版本**：[v1.4.0 release](https://github.com/earendil-works/pi/releases/tag/v1.4.0)、[固定 tag ref](https://api.github.com/repos/earendil-works/pi/git/ref/tags/v1.4.0)。
- **[S3] OpenCode embedded host**：[v2 SDK 概覽](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/services/www/src/docs/content/build/sdk/index.mdx#L5-L43)、[SDK storage／instance 邊界](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/README.md#L62-L78)。
- **[S4] OpenCode client／session／恢復**：[client live-only 與 service API](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/services/www/src/docs/content/build/client/index.mdx#L57-L77)、[session protocol：prompt 335、wait 459、context 508、log 665](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L335-L353)、[at-least-once recovery](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/execution/restart.ts#L46-L61)、[SDK 自動恢復](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/internal/host.ts#L51-L56)。
- **[S5] OpenCode v2 permissions**：[規則、預設與 approvals](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/services/www/src/docs/content/permissions.mdx#L183-L299)、[permission protocol](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/permission.ts#L113-L159)。
- **[S6] OpenCode v2 現成 web／remote**：[web、pair、SSH、remote、serve](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/services/www/src/docs/content/cli/web.mdx#L5-L130)。
- **[S7] Pi SDK**：[session storage、replacement、settlement](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/sdk.md#L26-L116)。
- **[S8] Pi RPC／extension 邊界**：[RPC lifecycle 與 process 責任](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc.md#L22-L95)、[extension tool gates／UI／OS 權限](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/extensions.md#L3-L7)。

部分猜測的舊路徑回 404／網頁工具無法開啟；改用同 repo 固定 commit 的檔案目錄與正確 v2 source 後完成核對，沒有以搜尋摘要補造缺失介面。
