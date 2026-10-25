# 公開交付與證據政策

本版本包含固定SDK的離線spike、fixtures、必要tests、lockfile，以及產品方向／上游研究。未開發正式UI或啟用live模型。

原先包含完整合成raw evidence的推送在執行前遭自動批准審查拒絕，理由是公開目的地與本機路徑／session IDs等metadata的外傳界線未明確。該提交與全部原始資料保留本地，沒有改用其他管道外傳。這個安全替代版本從原始main建立獨立歷史，不包含被拒的commit、raw事件、session transcript、run IDs、本機路徑、ledger或測試日誌。

只以欄位白名單產生 [公開摘要](../evidence/offline-validation-summary.json)：版本、環境類型、案例計數、斷言結果、程式／fixtures／lockfile hashes及原始收據hash。摘要不是原始trace；raw不公開的限制明列於報告。19項可執行內容hash保持相同，因此沿用既有35/35證據，不為包裝重建測試環境。

既有中間run／ledger與原始完整證據皆保留原地；本次不刪除、不覆寫。重新跑測試會產生新的本地raw檔案，.gitignore預設排除evidence內容，僅追蹤經白名單產生的公開摘要。此政策不代表有通用去敏器，也不授權將真實資料或新的完整輸出直接加入Git。

正式UI、服務恢復／窗口、真實模型品質與效率仍待後續確認。Git交付不代表產品方向已被使用者接受，也不等於部署或模型呼叫授權。
