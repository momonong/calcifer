# Wisp｜Hermes 對話中的 OpenCode 開發流程

`wisp-core` 0.1.0 是隨原始碼提供的選用開發插件。Wisp 啟動器版本為 0.1.4，網站下載版本為 0.1.3。


## 操作方式

Hermes 保留原對話、日常助理與工具；Wisp 擁有開發任務、批准、額度、候選、驗收及套回狀態；OpenCode 官方 SDK 2.1.4 負責開發迴圈。沒有嵌入另一個 CLI 視窗，也沒有 fork Hermes／OpenCode。

| 操作 | 實際效果 |
| --- | --- |
| 在原對話交辦 | Hermes 用 `wisp_propose` 建立精確檔案、命令與模型範圍，顯示任務卡；尚未執行 |
| 批准開發 | 先檢查平台、隔離工具與固定執行環境；通過後才在候選副本執行完整目標 |
| 批准驗收命令 | 每次核對精確 argv；唯讀候選、無網路、無主機 home 的 Linux 檢查環境 |
| 檢視 Diff 與結果 | 真實檔案差異、測試輸出／退出碼及額度；完整交辦與唯讀範圍可展開 |
| 退回修正 | 同一原生 OpenCode session、批准版本增加，舊測試及離線驗證資格失效；額度不重置 |
| 接受候選並結案 | 當前版本／候選的全部檢查通過才可接受；尚未套回來源 |
| 預覽套回、確認套回 | 重驗來源與候選、持久備份原檔與權限，再套回核定檔案。來源有改動就停止，不提供 force |
| 撤回／回復本次套用 | 只恢復仍符合本次套用內容的檔案；後來人工修改保留，衝突標示需處理 |
| 額度已用完／已確認停止 | 可先在候選目錄補完，再「預覽重新驗證 → 批准離線檢查」；僅跑原命令，0 次模型請求、總計最多 120 秒 |
| 重開接續 | 同一對話讀回狀態、收據、Diff、套用結果與來源，不重派；長交辦先壓縮再加入進度，驗收數只計當前版本與指紋 |
| 決策與待辦 | 在任務卡明確保存、標記待辦完成／重開或撤回決策；來源、版本與原文保留，不啟動新工作 |
| 專案接續與進度 | 讀取精簡摘要與下一步；同專案跨對話分享預設關閉，可明確開啟／關閉 |
| 模型來源與用量 | 面板上方展開後點讀取；只看本地設定與此對話全部 worker 帳本，分來源／模型統計，0 次模型請求。帳戶餘額、到期、tokens、費用未查詢 |
| 取消 | 先記 CANCEL_REQUESTED，再確認程序與請求結果；UNKNOWN 不自動重派或轉投其他模型 |

本機套回不等於 Git 提交、推送、合併或部署。這些都不會由插件順便執行。

## 怎麼使用

啟用插件後，開啟 Wisp 的應用程式或 `wisp webapp` 並選擇專案。實際開發會使用已設定的模型額度。

要提出下一個任務，可在選定專案的原對話說：

> 請使用 Wisp 開發流程，先提出這個問題的精確可讀與可修改檔案、驗收命令，用 wisp_propose 產生任務卡，等我批准才執行。不要改用其他工具繞過批准，也不要直接修改原專案。


## 保存決策與待辦

在原任務卡展開「決策與待辦」，選類型、填寫內容，再按「保存這筆紀錄」。紀錄只附在這個任務，帶原對話、任務 ID、批准版本、GUI／委託操作來源與時間；最多 32 筆，每筆 1000 字。

待辦可標記完成或重新開啟，決策可撤回；原文與狀態事件保留。標記完成只改待辦，不代表程式驗收通過或 UNKNOWN 已解決，也不會啟動模型。兩視窗同時修改時，舊紀錄版本會被拒絕。

原對話會讀到有效決策與未完成待辦；其他對話仍須先有同專案分享批准。GUI 摘要最多 4 筆×280 字，模型每輪最多 2 筆×140 字，文字或筆數省略會明示；必要時以 `wisp_status(objective_id=...)` 查看完整來源。未建立全域偏好、跨專案知識圖譜或排程提醒。

## 限制與保護

- **已驗證平台**。Ubuntu x64 與 5090 筆電上的 Ubuntu WSL2 使用 Linux worker、Bun 1.4.4 和 OpenCode SDK 2.1.4。Hermes 0.23.2 已跑過真實模型開發範例，5090 升至 0.23.3 後亦通過離線驗收。安裝器、GUI 與工作者共用前置檢查。缺少隔離工具或有效 runtime 時，會在啟動前保留提案。Windows 原生 worker 仍待移植。
- **檢查界線**：檔案與版本前置檢查不主動測 kernel／AppArmor／user namespace。實際驗收仍使用原 Linux 隔離；不自動調整系統設定。離線驗收不依賴模型 runtime。
- **模型**：支援 `hermes-openai-codex`（Hermes 的 ChatGPT／Codex 訂閱）與 `hermes-openai-api`（OpenAI Responses API）。提案依 Hermes profile 所選的供應商建立，已批准的任務保留其供應商和模型。OpenCode worker 只收到主機轉送的回應。agy、Broker、自架模型尚未接入，不靜默 fallback。
- **候選範圍**：最多 64 個明列 UTF-8 檔、每檔 256 KiB、總計 2 MiB，拒絕隱藏／秘密檔名、symlink、binary、越界。這適合小型明確任務，尚不能接任意大型 repo。
- **編輯**：`replace` 要唯一精確匹配；`replace_many` 同一檔最多 16 段，全部預驗後單次寫入，任一失敗則零修改。`edit` 可新增／整檔寫入。`search` 為 literal，提供 path 時只查核定檔。
- **檢查**：支援 `python3`／`python`／`node`／`npm` 精確 argv，不安裝依賴、不接網路或正式資料。輸出每串流約 16 KiB 保留頭尾；截斷明示，超過每串流 1 MiB 或時間上限停止。
- **額度**：預設 8 次請求、600 秒；等待批准也計時，修正沿用已用額度。worker 可看到剩餘請求及時間，硬上限仍由 controller 掌握。
- **離線驗證**：只限已確定停止、請求均已結算的候選；不允許 UNKNOWN、活躍 worker、額外檔案、讀取範圍被改或刪檔。驗證綁定批准版本、候選內容與檔案權限。既有檔案沿用來源的普通權限，新檔案使用 `0644`。候選中的額外目錄會擋下驗證。早期已接受但尚未套回的候選須先核對權限並重新驗證。
- **套回**：逐檔原子替換與持久備份；多檔不是檔案系統交易。外部編輯器不遵守 Wisp 鎖時仍可能競爭，不能宣稱防禦任意惡意同使用者程序。
- **記憶**：帶來源的任務／批准／進度摘要；分享只在同 profile、同 repo。沒有跨專案知識圖譜、偏好自動學習、排程提醒或統一用量頁。

取消尚未提交的 reservation 可阻止派發；已提交的 in-flight 請求可能仍被供應商處理或扣額度。本機程序停止不等於遠端撤銷。原生 Hermes 的其他工具仍沿用原權限，本插件不是整個主程序的 OS 沙箱。

## OpenAI API 設定

在 Wisp 專用 Hermes profile 執行 `hermes model`，選 **OpenAI → OpenAI API**，在隱藏提示輸入該組織的 API key，再選擇支援 Responses API 與工具呼叫的模型。Wisp 從同一 profile 的 `.env` 讀取 `OPENAI_API_KEY`，並固定使用 `https://api.openai.com/v1/responses`。使用贈額時，請在 API 平臺的 Credit grants 核對組織、剩餘額度及到期日。

## 安裝及更新插件

請指定已存在的 Wisp 專用 Hermes home。升級既有插件前，先確認沒有活動任務，正常關閉使用該 profile 的 gateway，再執行安裝。

```bash
python3 -B wisp/install-core.py --hermes-home /完整路徑/Wisp專用HermesHome --npm-cache /既有npm快取
```

只用本機 npm 快取與固定 lock；不足就停止，不改上網。安裝保留舊插件備份，不更改 auth/config／啟用狀態，遇活動任務、驗證、套回或未受管修改時拒絕升級。

初次安裝在 **Capabilities → Plugins → Rescan** 找到 **Wisp 開發流程／wisp-core**，開啟 Agent 與 Desktop 部分。後端 Python 變更後，Rescan 或重新整理網頁不足以替換已掛載的 API；先確認無活動工作，再用 **Backend → Restart gateway**，或正常退出並重開專用 Wisp。保留原 profile、專案及登入。

## 驗證界線

Ubuntu Webapp 有操作者協助的任務交付與重開接續驗證。5090 的 Windows 原生桌面也已連到 WSL2，開啟原任務查看 Diff 與套回結果。Git Bash 的 `wisp smoke --offline` 使用合成模型回應，在真實 Linux 隔離環境執行測試，另開程序核對同一任務。全新 Windows 機器從公開安裝包重建此組合仍待驗收。[5090 實機紀錄與範例來源](handoffs/wisp-wsl-development-2026-11-21.md)

操作錯誤會保留至下一次明確操作或「關閉操作提示」，背景更新不會清掉。來源改變時先比對 Diff，候選改變時重驗；未確認結果先查原收據，不盲目重送。切換對話不沿用舊錯誤或成功提示。專案摘要核對已消失的 worker，UNKNOWN 保留而不重派。

「模型來源與用量」是手動更新的本地唯讀畫面；讀取時間可見，不會自動呼叫供應商。統計包含取消前已占用的名額，不當作實際扣款。模型工具亦可用 `wisp_status` 的 `overview=true` 取得同一份資料。已批准任務的 provider 綁定傳輸接點；未知來源在 owner 啟動前拒絕，不默認改投 Codex。agy／Broker 仍未整合。

```bash
# 使用已具備 FastAPI/httpx 的 Hermes Python；須容許本機子程序及 user namespaces。
WISP_OFFLINE_INTEGRATION=1 python3 -B -m unittest discover -s wisp/tests -p 'test_*.py' -v
node --experimental-vm-modules wisp/tests/desktop.test.mjs
```
