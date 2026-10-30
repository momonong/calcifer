# P1-A 停止點與 P1-B 接續確認

**目前停在 P1-A：功能與後續修正已完成、推送並合併；P1-B 暫停，連離線接線也等待使用者再次明確確認。** OpenCode 為主選，Pi 保留對照。這份紀錄是接續入口，不授權執行下一階段。

使用者於 2026-10-30 明確要求：「先停在 P1-A。把目前進度和 P1-B 接續需要確認的事項記錄好，等我確認模型與實測窗口後再繼續。」目前不設定排程或 Goal、不自動 resume。原始報告、帳本、wire／native 與私密設定保留在私人位置，不納入公開文件。

## 已交付的程式與驗證

| 交付 | 內容 | 來源與合併 |
| --- | --- | --- |
| [PR #8](https://github.com/momonong/calcifer/pull/8) | P1-A 八模組與合成 taskboard 驗收 | feature `537f475020cb8e72661d93bee7fac5226e95cd2a`；merge [6e532dc](https://github.com/momonong/calcifer/commit/6e532dc3afb2a32506c17a4d04a596c6e6b5a13a) |
| [PR #9](https://github.com/momonong/calcifer/pull/9) | read／search 結果超限改為已知失敗，保留真正 ack 遺失的 UNKNOWN | feature `fe23cd248154889d2826fcd3bd55e9021ea9bc79`；merge [32a6321](https://github.com/momonong/calcifer/commit/32a6321fa7d0c38f54103575350d390a6e79d76f) |

本停止點的程式基線是 `32a6321fa7d0c38f54103575350d390a6e79d76f`。根 package 仍為 **0.0.7**，沒有發新版、release tag 或部署。已驗證環境：Node 22.22.2、Bun 1.4.4、OpenCode 2.1.4、Pi 1.4.0；其他平台／版本不由這些收據推定。

| 證據 | 結果與界線 |
| --- | --- |
| PR #8 的 P1-A 歷史完整驗證 | 158/158；保留 [原驗證摘要](p1-a-validation-2026-10-30.json)，不改寫為較新次數 |
| PR #9 回歸與受影響套件 | 同一回歸 RED 0/5、exit 1 → GREEN 5/5、exit 0；受影響套件 28/28、exit 0 |
| PR #9 最後完整整合 | `npm test` 163/163、exit 0；failed／cancelled／skipped 均為 0；log SHA-256 `79f8c80fdc1a031bc17397a0255a0927b4673c7d50e137366ba07aadc9eaf8c5` |
| 審查與交付核對 | PR #9 獨立窄範圍審查新增發現 0；GitGuardian 通過；已測 feature 與合併 tree 一致，當次本機／遠端 main 核對一致 |
| 模型與接受程度 | 真實模型請求 **0**；只驗證 mock 流程機制，尚未證明模型工作能力或人工接受 |

以上由已保存的交付收據核對；本次停止點只檢查文件與連結，沒有重跑測試或探測服務。

## P1-A 現在可做什麼

操作與設定契約見 [P1-A 使用入口](p1-a-usage.md)；新建合成資料的入口為 `fixtures/taskboard-cli/prepare.mjs`。P1-A 使用官方 SDK 的實際工具迴圈，provider 經短暫的 **loopback HTTP mock**，與早期程序內 mock 底座分開。

| 模組 | 已驗證能力 |
| --- | --- |
| 交辦入口 | 接收外部目標／目標檔、repo、host config、harness 與 mock profile |
| Repo／context | 有界完整 snapshot、工程規則與可讀檔案；保留原來源 |
| 檔案／命令工具 | scoped read／search、expected-hash edit、精確新檔 allowlist、預登錄隔離 Node 檢查與程序停止 |
| Provider 接線 | exact endpoint／本次 mock 身分與持久 request gate；兩套官方 SDK 實際經 HTTP |
| Worker／完成判斷 | 單 worker、有界請求；受保護 host acceptance 核對同一份最終成果 |
| 權限／狀態 | 越權拒絕、取消後停止派送、持久 UNKNOWN 阻擋盲重送、唯讀重開 |
| 驗證／觀測 | 綁定 manifest／定義／runtime 的收據、T2 同一回歸 red→green、原始輸出 bytes 與操作紀錄 |
| 成果交付 | 可讀摘要、完整 artifact／新檔、標準 patch；唯讀 reopen／export 與 tamper 拒絕 |

支援範圍仍是單 worker、少量完整 Node ESM snapshots 與受控工具。尚未提供完整 session resume／UNKNOWN 自動 reconcile、一般專案／任意技術棧支援、正式 UI、P2 自動多模型分派成效或 Spark 實機驗收；Linux 隔離也不等於 production hostile-code 安全保證。

## P1-B 開始前須一次確認

下列均為**待確認提案**，目前不能據此送請求或先做離線接線：

| 確認事項 | 接續時需要的明確資料／決定 |
| --- | --- |
| 模型與能力 | 精確 model ID、revision、backend、tool parser、context 與 tools／SSE 能力；由已授權的 ready／models 查核及非秘密部署 metadata 核對，不把歷史候選當現場事實 |
| Endpoint／認證 | 由服務 owner 提供當前執行位置可用的接入方式與安全來源；endpoint／credential 放 repo 外私密設定，不把值寫入 Git、CLI 參數、fixture 或公開紀錄 |
| 實測窗口／資源 | 明確起訖日期與時間（`Asia/Taipei`）；服務 owner 已確認 ready、使用資源無其他衝突；未 ready 或 metadata 不符即回報，不自行啟動或修服務 |
| 任務與比較範圍 | 只用全新合成 taskboard-cli 的 T1 小功能、T2 邊界 bug、T3 已知失敗／取消／UNKNOWN；兩 framework 用同一模型、工具與預算，live 任務不帶預設 patch 或預排工具動作 |
| 請求／輸出預算 | 建議兩 framework **共用最多 40 次實際 generation**，包含 canary、工具續輪與任何另獲准重試；併發 1、最多 20 分鐘派送；canary ≤512、工作任務 ≤1024 output tokens。40 是總上限，不是每框架各 40 或必須用滿 |
| Deadline | 由 owner 確認服務 deadline，不超過 30 秒或現場較低上限；request header 只能縮短，client transport 略大於服務 deadline，SDK／工具／drain 期限一併對齊 |
| 成本與禁止擴張 | 實際成本 unknown；無付費 fallback、不下載權重、不恢復或變更服務、不碰現有業務 repo／真實使用者資料 |

原先 ≤512 的接入 smoke 授權**不自動涵蓋** P1-B 的新任務資料與新窗口，也不代表上述 40／1024 提案已批准。

固定 selfhost 參考契約為 `45ebfd57db5313292ae8f38e733f3e2894a99e5f`；其 API 文件與 schema 的 `max_tokens` 上限是 **1024**，不代表當前 live 部署已就緒。原 2048 提案與契約不相容，已撤回。Calcifer 的 `validateProfile` 目前仍硬限 **512**；若後續批准工作任務 1024，必須在授權後先補必要 client／SDK／policy 接線及 mock 驗證，不能只換 endpoint 或略過上限。

## 使用者確認後的最短接續順序

1. 使用者明確確認模型、任務範圍、資源／預算與窗口；在此之前維持停止，包括離線 P1-B 工程。
2. 唯讀核對指定 worktree／refs、這份停止點及固定服務契約；若版本或契約有差異，先回報，不自行改服務。
3. 僅補必要 real-profile transport、跨兩 framework 的共享 40 次持久帳本、deadline 與真實 provenance；保留既有安全工具與官方 SDK，live 任務不載入 scripted solution。先用 mock 驗證接線差異，沿用充分的同版本證據。
4. 到已授權窗口後，依 owner／ready／models 與非秘密部署 metadata 核對實際能力；未 ready 或不符即回報。只有 metadata 相符且仍在獲准窗口內才做有界 live。UNKNOWN、額度或窗口到達即停止新派送；保留 operation／request 與收據，不換 session／payload 盲重送。
5. 回報 correctness、efficiency、測試完整性、越權／重複工作與人類介入；usage 未報告就標 unknown，另列截斷、context／額度／窗口耗盡與任務錯誤。小樣本不宣稱框架或模型勝出。

此紀錄保存接續條件，不建立排程、Goal、背景監工或自動恢復機制；下一步等待使用者確認。
