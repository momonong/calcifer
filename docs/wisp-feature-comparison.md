# Wisp 現在做出了什麼？

查核日期為 2026-11-18（Asia/Taipei）。

**Wisp 是以 Hermes 為入口的個人助理。** 選用的 `wisp-core` 開發插件以 OpenCode SDK 作為開發執行器，提供任務批准、候選驗收、備份套回與接續。[Wisp 開發流程](wisp-opencode-workflow.md)。

## 三者的分工

| 比較面向 | Wisp 目前 | 原生 Hermes Agent | OpenCode |
|---|---|---|---|
| 產品方向 | 日常與開發共用個人助理；目前以 Hermes 實現 | 通用助理與工具執行，包含開發 | 以程式開發為核心的 coding agent |
| 介面與 agent loop | 沿用 Hermes Desktop / Webapp | 官方提供並維護 | 自有 CLI、Desktop、Web 與執行器 |
| 模型供應商 | 沿用 Hermes 接點；目前驗證的登入路徑是 ChatGPT/Codex | 支援供應商設定 | 支援多種供應商與自訂設定 |
| Skills / MCP | 使用 Hermes 已有能力，沒有另造標準或接完所有外掛 | 原生擴充能力 | 也支援 Skills / MCP，不是 Wisp 獨有 |
| 記憶與接續 | 沿用 Hermes 記憶／對話；已驗證文件與歷史找回 | 有跨 session 的持久記憶機制 | 有專案指示與對話上下文；不推論其等同個人長期記憶圖譜 |
| 安裝與隔離資料 | Wisp 專用設定、固定封包、同名命令保護、重裝保留 | 官方安裝、profile 與更新機制 | 官方安裝與自身設定 |
| 開發閉環 | Hermes 原生隔離案例已驗證。選用插件也完成操作者協助的開發、驗收及套回 | 真正執行該案例的引擎 | 開發插件使用 OpenCode SDK 2.1.4 |
| 主動進度／額度治理 | 插件提供任務進度、本對話請求用量與離線收尾 | 可用原生能力作基礎 | 可用自身 agent 與擴充作基礎；本輪未實測 |

OpenCode 官方將它定位為開源 coding agent，提供三種介面與多供應商接點。[OpenCode 官方文件](https://opencode.ai/docs/) 明列這些能力；[MCP 文件](https://opencode.ai/docs/mcp-servers/) 與 [Skills 文件](https://opencode.ai/docs/skills/) 說明擴充方式。這些是上游能力，沒有因此自動整合到 Wisp。

Hermes Desktop 與其 CLI／gateway 共用 agent 核心及資料機制，Wisp 正在使用這個架構。[Hermes Desktop 官方文件](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)。Hermes 的持久記憶本來就能保存偏好與專案資訊；這不能算成我們新開發的記憶系統。[Hermes 記憶文件](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)。

## 我們實際新增的功能

1. **Wisp 統一命令**：版本、診斷、狀態與準備入口。0.1.4 的 Linux 桌面設定讓命令與應用程式選單開同一個官方桌面；保留明確的瀏覽器入口。
2. **跨平台安裝包**：Linux Python／Shell，Windows PowerShell／CMD／Git Bash；安裝固定版 ZIP 並核對 SHA256 與檔案 manifest。
3. **安裝保護與可回復版本**：候選版本探測、逾時停止、同名命令與使用者修改保護；重裝復用設定，保留舊 releases。
4. **專用 profile 整合**：指定既有登入的 Hermes home，隔離資料路徑並清除會導向其他 profile 的繼承設定。這不是 OS 權限沙箱。
5. **舊 Windows Hermes 的相容準備**：把所需固定版引擎準備在 Wisp 目錄，保留原 Hermes 安裝與登入。
6. **安裝網站及操作文件**：提供固定下載與測試說明。現行網站仍是 0.1.3；不是託管私人聊天或 agent 的雲端服務。

## 我們完成的驗證，與沒有新增的功能

日常研究、保存與修訂文件、找回歷史、應用內提醒、拒絕、停止及斷線接續已有 Hermes 原生實測證據。這些成果證明底座可用，不能說是 Wisp 重寫了它們。

開發案例在隔離的 Knowledge Hub 副本完成閱讀紀錄搜尋：交辦、實作、Diff、一次真實退回修正、40 項測試、五檔接受套用及重開結案。搜尋功能是該驗證專案的成品，尚未合入正式 Knowledge Hub，也不是 Wisp 引擎的新功能。

Ubuntu 0.1.4 桌面已對齊 Hermes 0.23.2；使用者確認獨立視窗、原專案與對話正常。Windows 0.1.3 已確認安裝、登入、基本對話與立即重開；0.1.4 的 Windows 實機升級、完整開發流程和原生 Desktop 尚不能標為通過。OS 通知送達也沒有因此通過。

## 還沒有做出的產品能力

- 根據目標、自動選擇 Hydrogen／Codex／其他執行器的 Wisp router。
- agy、API Quota Broker 與 Hermes 主流程的完整整合及切換驗收。
- 跨供應商額度、到期時間、成本和 fallback 的統一控制面板。
- Wisp 自有的長期記憶／知識圖譜、跨裝置同步與公司資料邊界。
- 跨工具的一致管理層。Wisp 目前管理自己的明確批准、取消、候選與驗收流程。
- 自訂瀏覽器、computer-use 執行環境或虛擬機。

供應商替換需在 Wisp 核對主模型、輔助模型、fallback 與實際任務。社群 agy 外掛、供應商選單與舊版 `calcifer` CLI 的 adapter 各有自己的驗證範圍。

## 舊成果如何保留

舊版 `calcifer` CLI、Codex／agy adapters、任務契約、隔離與恢復實驗保留在專案的歷史程式與文件中。這套執行層與試驗各自沿用原有入口及授權。公開 Git 保存已核定的原始碼與文件。

目前最有價值的進展，是確認一套現成引擎可以承接日常和開發，並把啟動、安裝與保護流程做成可延續的成果。Wisp 更進一步的差異化，仍要由已確認的使用需求決定；這份說明不啟動下一階段。
