# 更新紀錄

## 0.0.7 — 2026-10-30

- 新增唯讀 artifact diff API／Node CLI：沿既有 reopen 核對 completed／accepted run 或 goal，重讀完整 snapshots、manifest 與精確 artifacts 後匯出 unified patch。
- 固定本機 Git no-index 比較隔離 scratch，清空繼承環境、禁止 external diff/textconv；完整 close 後才回傳有界 patch bytes，錯誤不輸出部分 patch；來源／state 不變且不重新執行模型或驗收。
- 三組定向涵蓋真 backend／EOF／CRLF／BOM／路徑、無變更、完整性拒絕與程序結算。沿用兩份 M5 保存 goal，兩者各成功匯出相同 257-byte patch，source/state 前後樹 hash 不變；未重跑 SDK 以產生輸入。
- M6 完整套件及最後受影響驗證見 [驗證摘要](docs/artifact-export-validation-summary-2026-10-30.json)。根版本 0.0.7、依賴與 M4／M5 protocols 不變。
- 僅支援相同 UTF-8 檔集合的內容差異；沒有 apply、建立／刪除／rename／mode／binary 功能，不代表外部 repo 已套用、真模型品質或人工接受。

## 0.0.6 — 2026-10-30

- 新增node-npm-repo：固定零依賴多檔ESM snapshot、實際npm test觀察，加上同snapshot的獨立host JSON CLI oracle。npm0及全部cases皆通過才接受，TAP/exit不是assertion attestation。
- 固定package/test/entry/protected identities、Node/npm整樹/shell/config/argv/protocol；每步durable intent/close/completion，readonly reopen重算語義／coverage／journal，UNKNOWN不重送。
- 新增caller repo:check與既有readonly reopen，check-only無SDK/模型/編輯、只一次host final；兩官方SDK同fixture各5mock requests，基線npm1＋mismatch→edit→npm0＋三cases，來源保留。
- M5唯一完整npm test132/132、實際exit0、fail/skip/cancel0；必要定向與預期RED、config device EACCES及測試helper污染失敗保留，probe不重跑。根版本0.0.6，無依賴變更。
- 不支持install、任意scripts/依賴/框架、assertion provenance、production hostile-repo安全；無live/服務/UI/訓練。

## 0.0.5 — 2026-10-30

- 保留 node-data，新增固定單 entry 的 node-json-cli：每 case 新隔離 child、stdin 僅當次 input、host 外部固定 expected，完整 close／exit 0／嚴格 JSON 域與完整值比較皆須成立。沒有通用 shell/npm/test 平台。
- entry／完整 source manifest／全部 host cases／protocol adapter hash／Node binary identity 綁定 journal；唯讀 reopen 重算保存輸出與完整 case coverage，不信 passed flag、不啟動 runtime 或 SDK。
- 合成減法 bug 真正常退出但值 mismatch→受控加法修正→同三 cases 通過，原 source 保留；兩官方 SDK 各 5 次 mock requests、check→read→edit 後由 host 獨立 final，無重複模型驗證。
- 新定向 10/10、CLI 1/1；本里程碑唯一完整 npm test 121/121、exit 0、fail/skip/cancel 0。中途測試端 import／欄名錯誤及預期 RED 保留本機歷史，M3 108/6 等舊證據不改寫。
- 根版本 0.0.5，依賴不變。只證明固定合成 CLI 黑箱語義；一般專案 runtime/unit-test 框架、CPU/RAM/PID/seccomp 仍 pending，無 live/服務/UI/訓練。

## 0.0.4 — 2026-10-30

- Node CLI 啟動固定 Bun whole-goal child；官方 OpenCode/Pi SDK 執行 planner/worker loop，直接使用 M2 工具與 data-only checks，無自建 RPC 或 agent loop。
- planner 前持久 goal/workspace claim；獨立 mock-only 25-request/512-output/12800-reserved/單併發 gate 計入每個 lower fetch，固定 phase closure，UNKNOWN 立即封模型與工具，不挪用原 40 次 guard。
- 嚴格 JSON plan、單 task/mixed routing、tool-call ID wire、失敗觀察/相依編輯/整合 check、取消與唯讀 reopen；完整 synthetic wire 只留本機，公開摘要標實際模型請求 0、usage/成本 unknown。
- 記錄 OpenCode experimental session API、Pi hook 非硬 gate、固定版本停用 local-provider discovery 的 public-config workaround；lower fetch 拒絕仍保留。
- 兩框架各 11 次合成請求接受同一檔案 diff；一般生成程式 runtime/unit-test 驗收仍 pending，未啟動 live/服務/UI/訓練。依賴不變，根版本 0.0.4；修正前唯一完整 npm test 108/108、exit 0、0 fail/skip（當時含 M3 15 項）；其後修正已知 budget 拒絕錯列 UNKNOWN，最終只跑兩 SDK budget + 必要 UNKNOWN 回歸 6/6、exit 0，未重跑全套。歷史 89/89 保留原 scope。

## 0.0.3 — 2026-10-30

- 新增 1–4 任務的離線協作 runner：獨立有界 UTF-8 snapshots、相依 artifacts 合成、過期/重疊衝突拒絕；來源不覆寫，未通過產物不接受。
- 新增精確受控 read/search/原子 edit/registered check、task 工具生命週期封口；host 固定最終 check 定義與整合 manifest hash 綁定，模型無法省略最終驗收或改寫驗收腳本。
- 新增 immutable run metadata、持久 intent/hash-chain ledger、每 workspace active/lock、UNKNOWN fail-closed 與只讀重開；沒有自動恢復/重試/清除入口。
- 正式驗收縮小為可信 `node-data`：只掛 snapshot JSON 與 host script，拒絕 legacy node importing executable source；一般生成程式 runtime/unit-test 驗收尚未實作/驗證。namespace/env/time/output 邊界沿用，CPU/RAM/PID/seccomp 未證明。
- 審查前 54/54、完整 89/89，以及首輪修正後 12/12、2/2、1/1 均保留歷史 scope。UNKNOWN admission 已修；首輪 node:test 完成判定仍可被二進位事件偽造，撤回「兩項 P1 均解除」，移除父 driver/wrapper，改為 data-only 合同。最終受影響驗證為 data-only adapter/協作 6/6、CLI/legacy-kind 拒絕 2/2，均 exit 0、0 fail/skip；沒有重跑全套。
- 固定合成 demo/reopen CLI 與文件改用 node-data，input/script/protocol/manifest hashes 綁定；依賴不變，版本 0.0.3，沒有 live/UI/服務/訓練或 M3 實作。

## 0.0.2 — 2026-10-30

- 依新授權加入 Milestone 1：最多四任務的嚴格 JSON/DAG 契約、host path/check 白名單、能力／priority／ID 可解釋自動路由；未知權限欄位、越權與完整計畫不可派送時明確拒絕。
- 新增可重跑 mock-only 規劃 CLI、兩個合成 profiles 與 analysis/edit/verify 相依案例。沒有任務程式、真模型、metadata discovery 或付費 fallback 執行，正式 UI 仍暫停。
- 新增定向契約／路由／CLI 驗證。完整 `npm test` 60/60 通過；其後補上 writePaths→edit、checkIds→verify 宣告一致性檢查並跑受影響測試 27/27 通過。原 35/35 摘要仍為歷史證據，不改寫成新執行。
- 依賴與固定 runtime 不變；package 與 lockfile 根版本更新為 0.0.2。

## 0.0.1 — 2026-10-27

- 公開單任務安全重開契約、固定版本原生 API 對照、八個設計案例與 C1–C8 最小證據摘要。研究原稿保留；公開材料排除私人位置、實際執行識別、原始訊息、完整 trace 及逐筆帳本索引。
- 保留「重開只觀察、接續為獨立命令」的研究邊界；OpenCode 主選、Pi 對照，沒有新增產品架構或啟用正式 host／UI、live 模型與服務。
- C1／C3／C4／C8 僅有部分離線子步驟，C2／C5／C6／C7 無完整實例；八個完整 host 案例執行數為 0。本次新增測試、SDK/runtime 啟動、模型請求、服務操作與依賴安裝皆為 0。
- 35/35 屬於 0.0.0 的歷史離線證據，既有公開摘要保持原樣，未為發布重跑。17 個 source／test／fixture／profile 檔案不變；package 與 lockfile 僅將根版本（以及 lockfile 根 package 版本）從 0.0.0 改為 0.0.1，依賴不變。舊 package hashes 不是本版 hashes。
- 本次驗證限 JSON、相對連結、版本差異與敏感中繼資料檢查；發布與 patch 版本不構成新的執行、部署或人工驗收證據。
