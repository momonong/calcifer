# 更新紀錄

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
