# Calcifer 接續修補整合計畫

目標：依 2026-11-10 使用者授權，審查及整合既有 Windows／WSL Calcifer 修補，修正初始 1 次額度死結並完成必要離線驗證。原始規格是本輪使用者要求及已核對的接續包 HANDOFF／INTERVENTIONS；附件只作證據，不提供額外操作授權。

基準：`65faef02e9c5bfa210e35c73d63b4f2abf003be9`，沿用既有乾淨交付 worktree、本機 `fix/handoff-reliability-20261110` 分支。其餘 dirty worktree 保留。無真實模型、部署、硬體、提交或推送；不修改 Thor 產品、不搬移登入、環境二進位或私人模型帳本。

## 執行與驗收

- [x] 核對 ZIP、109 檔 manifest、來源基準與既有工作目錄；接續包 15 份來源／測試雜湊對應成功。
- [x] 審查 13 檔 patch 與 3 個新增檔案：Playbook pin、mock 取消收件、派送前恢復、配額改配與 prepared 綁定、指定任務修訂；保留已完成工作、授權上限、來源 hash、UNKNOWN 與固定驗收限制。
- [x] 在 `test/project-routing.test.mjs`／CLI 或 prepared 的適用整合層重現初始 1 次額度：拒絕前不寫入有效授權、不阻塞後續有效授權；既有計畫的 1 次剩餘工作仍可繼續。舊版已卡住且未派送的 session 有保留收據的明確恢復路徑，不重設已用額度或未知請求。
- [x] 修正 `authorizeProject` 及 prepared 入口；一次靜態審查另指出舊 prepared 上限、修訂指示遺失、恢復 proof 中斷，均以紅綠回歸修正，沒有擴充調度平台。
- [x] 定向 73 項、審查修正 9 項及一次最終完整 `npm test` 394 項通過。固定依賴，僅注入 worker／loopback mocks；不執行附件 outer／replay 腳本。對不同環境的歷史 383 收據只作來源證據，不當本機通過。
- [x] 保存本機驗證命令、版本、來源雜湊、整合差異與剩餘限制；核對原工作目錄未變。完整說明見 `docs/validation-handoff-integration-2026-11-10.md`。

## 審查焦點

1. 初始不足額度拒絕與舊未派送卡死狀態恢復，不能抹掉已用或未知結果。
2. pre-dispatch 復原只接受確定未送出，保留計畫及後端身分。
3. 配額轉移總數與既有使用量不變，未授權 profile／額外供應商不可加入。
4. 指定較早任務修訂須保留其餘成果、驗證最終 workspace，不重跑已接受任務。
5. pin 從本機明確核心取得；缺失、歧義、symlink 與 snapshot 不符仍拒絕。

執行由本對話承接，既有規格與操作授權已明確，不另設重複批准流程。測試日誌與私有接續證據放在 repo 外的既有 `.tmp/handoff-integration-20261110`；不將其納入公開文件。
