# 安全重開：C1–C8 公開證據摘要與第一階段邊界

日期：2026-10-27（Asia/Taipei），公開摘要版本 0.0.1。這是私人研究材料的**公開衍生摘要**；原稿保留，公開包不含其位置或識別。這次文件更新沒有啟用正式 host／UI、模型呼叫或服務。OpenCode 維持主選，Pi 對照；模型使用明確設定檔。

**既有證據支持小任務結果、模型 UNKNOWN 拒送、合成工具收據對帳，以及同程序乾淨重開後的有限接續；尚不支持完整產品的安全重開。** C1–C8 仍是八個未執行的 host 設計案例。不能因其中幾個子步驟已有離線證據，就將整例標為通過。

建議第一階段候選維持「存活 host 重連＋已保存成果閱讀」，先把觀察與執行分開。完整 crash recovery、過期批准重播、遠端 UNKNOWN 結算與自動續跑不納入。這個範圍仍待使用者確認；本包沒有開始實作。

## 來源與證據等級

- [機讀最小摘要](safe-reopen-evidence-map-2026-10-27.json) 僅保存 C1–C8 的支持範圍、缺證據、允許下一步、證據等級及來源程式相對路徑；不附實際 run／intent／operation／session 識別、私人檔案位置、逐筆 JSON pointer 或原始帳本。
- **R：留存觀察**。既有官方 SDK＋固定 mock 的報告、帳本與結果快照。這不是 live 模型能力、遠端狀態或人工驗收。
- **H：舊測試結果**。同版本 35/35 通過的原始輸出，配合相應測試程式確認涵蓋範圍；沒有重新執行。
- **S：原碼依據**。固定版本的 guard、worker 及原生 API；能說明可能行為，不等於該故障或整合流程已實測。
- **P：提案**。host 欄位、跨層一致性、任務完成判斷與可用動作；尚未實作。

公開的歷史依據見 [0.0.0 離線驗證摘要](../../evidence/offline-validation-summary.json)。主要採用 strict adapter／guard 的既有離線實證；早期 characterization 僅作範圍內對照，不混併成另一輪 live 成效。摘要不是原始收據或完整可重建 trace。

## C1–C8 對照

| 案例 | 已有實例與可支持的狀態 | 缺少的原生／host 結果 | 具證據的下一步與界線 |
|---|---|---|---|
| **C1 正常完成** | R：兩框架 T1 只改 `note.txt`；T2 只改 `range.mjs`，相關 probe 由失敗到通過；哨兵未變。各自模型終態、原生訊息及結果快照可查。 | 沒有正常完成後重開、pending inbox／批准已清空、正式交付紀錄、工作版本綁定或接受／退回流程。原生 session 檔已清除；報告快照不是現在仍可開啟的 DB。 | 現在可只讀核對舊結果與證據；不能從 `settled`、`stop` 或 `log.synced` 單獨推導「產品任務已驗收」。完整 C1 仍未執行。 |
| **C2 UI 斷線、owner 存活** | S：同一 runtime 的狀態讀取與事件介面存在。 | 沒有 UI 斷線／重連、owner 身分或 snapshot／事件競態的留存實例；不能拿一筆 intent 到 completed 的時間差代替 UI 斷線實證。 | 可制定附著原 runtime 的候選流程；目前只讀研究摘要。不得重送 prompt 或重建 runtime 作健康檢查。 |
| **C3 模型結果 UNKNOWN** | R：cancel、缺 `[DONE]`、error frame 等各有原 intent 與 unknown，沒有 completed；不完整回覆案例重建 guard／更改 payload 後仍拒送。 | 沒有遠端推論查詢、終態收據或模型 UNKNOWN 的結算 API。取消案例未證明遠端停止。 | 保留原 run／intent／預算，讀原帳本、呈現待核對；不能換模型、帳本或 session 重送。沒有 remote ID 時明列缺口。 |
| **C4 工具結果 UNKNOWN** | R：T3 的合成工具操作已產生一次合成效果，receipt 未 ack；clean reopen 後生成仍被擋。讀回 receipt、顯式 reconcile 後才續寫，效果仍一次。C4 對應前階段，最終紀錄已結算。 | 沒有一般 shell／網路工具的原子收據或跨程序 exactly-once；工具 receipt 的原檔不再保留，只有報告內快照。 | 現在只讀歷史 receipt／effect 快照；未來只針對可信、同一 operation 的原收據核對。不能以此清除模型 UNKNOWN。 |
| **C5 重啟＋舊批准** | S：原生 pending 批准有記憶體生命週期，OpenCode 啟動恢復有副作用風險。T3 只有 clean close/open。 | 沒有舊批准跨 host 死亡、過期或重放的執行實例；沒有完整啟動前 model＋tool gate 證據。 | 保留唯讀恢復暫停，舊批准只作歷史。不得把 clean reopen 升格成 crash／批准復原成功。 |
| **C6 模型 terminal、native 答案未保存** | S：guard 先寫 completed 再把回覆交 SDK；存在可推導的跨層保存窗口。 | 沒有注入該窗口的 crash、缺失答案或可恢復 response 的實例；既有 completed 不是缺口實證。 | 若未來遇到不一致，檢查既有存儲並標示結果缺口；不能從 usage 重建答案、假報完成或無聲重新生成。 |
| **C7 已知任務帳本遺失** | S：guard 遇 ENOENT 回空事件，自己不知道這是原有任務。 | 現行 spike 沒有 task→原 ledger 的持久綁定；沒有「已知任務原帳本遺失」實例。既有檔案完整性比對不構成遺失測試。 | 將 host 缺檔拒送列為必要前提；不能把空事件當零消耗或新 40 次額度。現在不建立新帳本來模擬。 |
| **C8 已知暫停後明確接續** | R：T3 是有限子例：同一合成 operation／原 guard run，收據對帳後第二次模型請求完成，沒有第二次工具效果。 | 沒有任務授權／profile hash、owner 唯一性、hidden queue、workspace 與完成條件的完整重新核對。這不是 production continue command。 | 可保留此子例作未來接續邊界的依據；實際接續須另行授權並核對全部前提。開啟畫面不能觸發接續。 |

C2／C5／C6／C7 沒有對應的完整執行實例，機讀摘要明列缺證據，不借用其他案例冒充。C1／C3／C4／C8 只有部分離線子步驟證據；八個完整 host 案例的執行數仍為 0。

## 這次查到的狀態陷阱

1. **`case.unknown` 不是模型 UNKNOWN。** 它是工具 fixture 遇 `UNKNOWN_RESULT` 設定的旗標。cancel／不完整串流可以是 `case.unknown=false`，同時 `guardState.unknown` 非空；T3 可以保留 `case.unknown=true`，但已有 `reconciled=true`。兩欄不能當統一狀態燈。
2. **`stream.drained` 與協定終態不同。** cancel 的 `streamDrain=false`；缺 `[DONE]` 等案例即使本地串流讀完，仍沒有 adapter 接受的 terminal。`settled=true` 同樣不能消除 UNKNOWN。
3. **報告中的 native messages／events 是留存快照。** `worker` 結束會刪掉隔離的 session 目錄；不能依報告裡的舊路徑再 open。OpenCode 保存了部分 session ID／事件欄位；Pi 報告未保留可用的 session ID／實際 sessionFile 位置，不能猜補。
4. **識別必須帶範圍。** 合成 operation ID 與 fixture tool-call ID 在不同合成目錄會重複；使用 `(run, framework, case, operationID)` 查來源。guard intent ID 是本地 ID；本輪相關 ledger 的 `requestID/serviceVersion=null`，不能聲稱已對上遠端服務請求。
5. **`guardState` 可以是跨框架共用帳本的累積快照。** 單例 request 應用實際 payload SHA-256 對應 intent，再用 framework／task／次序核對；不能將整個 shared ledger 的所有 intent 都歸給該例。
6. **T3 所謂「Read-only status check」實際是 prompt。** 那次是刻意驗拒送，不是安全查詢 API；不能照搬成產品重開流程。clean reopen 也沒有重啟整個 worker 程序。

機讀摘要只保留上述辨義與來源程式相對路徑，不提供原始逐筆索引。這些辨義不修改舊資料，也不重寫原收據。

## 四個使用場景，哪裡有證據

原產品文件以三段一天情境表達；這裡將其中「交辦／交接、介入、驗收、續跑」拆成四個核對維度，**不是宣稱已有四個端到端場景測試**。

| 使用場景 | 真正已有的證據 | 仍是設計提案／欠缺 | 第一階段應如何呈現 |
|---|---|---|---|
| 交辦／交接 | T1/T2 有固定自然語言任務、同一工具集合、檔案差異與結果；T3 有原生訊息 readback。 | mock 回覆是預先編排；沒有模型自行理解／策略調整的品質證據。沒有正式任務與授權、owner、profile、原 ledger 的交接保存。 | 建立契約前只稱「既有離線成果」。未來交接摘要必須連原任務與原帳本，不能以新 session 代替原工作。 |
| 介入／批准／停止 | C3 的本地取消與 UNKNOWN 分離；C4 的合成 receipt 對帳可追溯。固定 API 有當前批准介面。 | 沒有真人決策、批准範圍綁定、過期批准重連或遠端確實停止的整合實例。 | 分列停止等待、stream drain、工具狀態、遠端狀態；只回覆目前 owner 的有效請求。批准重播與一鍵清 UNKNOWN 不支援。 |
| 驗收 | C1 有受限 diff、T2 先失敗後通過、哨兵不變；35/35 是同版舊證據。 | 沒有完成條件與當前 workspace 的持久關聯，也沒有人工接受紀錄。使用者滿意度、效率和 live 正確性仍 unknown。 | 展示已有 diff／必要驗證／限制，接受與生成分開；不因重開再跑測試。跨版本或資料變更時才重新評估證據適用性。 |
| 續跑 | C4/C8 的 T3 單次副作用、對帳後明確續 prompt；C3 的未結算拒送。 | C2/C5/C6/C7 的完整重開路徑沒有執行證據；未證明 crash 恢復、跨裝置接手或 remote reconciliation。 | 原 owner 活著才能考慮附著；未知、缺檔、結果缺口一律只讀核對。繼續是獨立命令，不隨畫面開啟觸發。 |

## 由證據導出的第一階段能力表（提案）

下表是**採用後的候選邊界**，不是目前已存在的正式功能。原架構／UI 仍暫停。

| 能力 | 建議範圍 | 納入前需要補的最小證據／前提 |
|---|---|---|
| 已交付結果的唯讀閱讀 | 第一階段候選；即使 host 不在，也可顯示可信的已保存成果與證據時間 | 保存 task／workspace／profile／ledger／native 結果關聯；缺關聯時只標「歷史成果」，不標本次已完成 |
| 存活 host 的進度重連 | 第一階段候選，限單機、單 owner、原 runtime | C2 的一次受控整合驗證：不重送、不遺失有效 pending、標明 snapshot 新鮮度；不得透過 runtime create 探測 |
| 當前批准／停止呈現 | 條件式候選；現有有效請求與停止狀態分開 | 操作綁定當前 owner／request／scope，停止須處理實際 queue 語義；目前只有來源與部分取消證據 |
| 模型／工具 UNKNOWN 顯示與拒送 | 必須保留；未知時仍可只讀資料 | 使用原 ledger，分開模型與工具；不能直接映射 `case.unknown`。需 task→ledger 固定綁定與缺檔拒送 |
| 已知暫停後的明確接續 | 不算在首個唯讀重開驗收內；只有另確認範圍才納入 | C8 的 owner、queue、授權、預算、workspace、profile、native 保存全數核對；T3 子例不足以放行 |
| Host crash 後自動恢復 | 不支援 | model＋tool 啟動 gate、跨層結果保存與重播語義均未證實；不得用 OpenCode create 作唯讀查詢 |
| 過期批准重播／未知結果自動重送 | 不支援 | 現有證據要求保留 UNKNOWN 與舊識別；沒有可授權的通用自動結算方式 |
| 多模型自動路由／跨模型解 UNKNOWN | 不支援 | 已確認只用明確 profile；換模型不能消除舊請求狀態或重置任務預算 |

OpenCode 有必要的 session／事件介面，但啟動恢復與 ephemeral pending 要額外處理。Pi 核心重開不自動 continue 的語義有利於控制，但不能補齊上述 host 缺口，也沒有本輪完整流程勝出的實證。**目前沒有足以改變主選的證據。** 原生 API 的精確固定來源沿用 [首包 API 對照](native-reopen-api-map-2026-10-27.md)，本包沒有重新研究版本或下載上游。

## 採用前需由使用者決定

1. 是否接受第一個安全重開驗收只涵蓋「活 host 重連＋成果閱讀」，將明確續跑和 crash recovery 分開。
2. 若後續批准工程，選定唯一持有 task／原帳本與外送 gate 的 host；不能先做 UI 再假設 guard 會補上身分綁定。具體 host 方案仍待決策，不在本包選定或實作。
3. UNKNOWN 暫時採唯讀核對、不提供重送捷徑，是否符合日常使用需求。遠端模型結算必須等 selfhost-models 的現行契約、服務窗口與授權另行確認。

這些是下一階段的決策項，不需要為完成本包而即時回答，也不表示已授權開工。後續若批准驗證，只補該階段缺少的案例，不重跑整套 35 項來代替新流程驗收。

## 公開範圍與本次查核

私人研究原稿、原始收據與歷史資料保留；公開摘要排除主機絕對路徑、實際聊天／執行識別、原始訊息、完整 trace，以及原始帳本逐筆來源與 JSON pointer。程式相對路徑與固定官方 source links 保留，供讀者核對論證範圍；這不使未執行案例變成實測。

原研究階段曾唯讀核對既有檔案完整性；這不是新測試，也不涵蓋已清除的原生暫存檔、依賴或服務狀態。

35/35 屬於 0.0.0 的歷史離線證據，歷史公開摘要保持原樣。0.0.1 保持 17 個 source／test／fixture／profile 檔案不變；package 與 lockfile 僅更新版本欄位，舊 package hashes 不能充作本版 hashes。

本次公開包裝只查核 JSON、相對連結、版本差異與敏感中繼資料，沒有重跑測試或 SDK。**完整 host 案例執行 0、新增測試執行 0、SDK/runtime 啟動 0、模型請求 0、服務操作 0、依賴安裝 0。** 正式 host／UI、live 品質、遠端 UNKNOWN 結算與人工驗收仍 pending。Git 交付與本文件研究／包裝活動分開核對；版本發布不是新的執行證據。
