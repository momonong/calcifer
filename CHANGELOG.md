# 更新紀錄

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
