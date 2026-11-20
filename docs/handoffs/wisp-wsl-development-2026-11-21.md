# Wisp 開發成果與 5090 接續說明

Wisp 希望讓同一位助理能辦日常事務、陪使用者逐步修改軟體，也能在雙方談妥目標與驗收規格後負責開發。截至 2026-11-21，5090 筆電已能用 Windows 原生桌面連到本機 Ubuntu WSL2，讓模型在隔離範例修改程式、查看 Diff、執行測試、套回並在重開後接續同一個任務。

## 從 Windows Git Bash 使用

| 指令 | 5090 上的行為 |
| --- | --- |
| `wisp` | 開啟 Windows 原生 Hermes Desktop 視窗，連到 WSL 的 `127.0.0.1:18769`。 |
| `wisp smoke --offline` | 建立新的隔離範例，自動驗證 Diff、候選測試、套回與重開，並印出範例位置。真實模型請求為 0。 |
| `wisp desktop` | 使用原 Windows profile 開啟桌面版，讀取原有登入與對話。 |
| `wisp webapp` | 使用原 Windows profile 開啟瀏覽器版。 |

5090 的 WSL 安裝為 Wisp **0.1.4**、wisp-core **0.1.0**、Hermes **0.23.3**（`caafe5389ae585ef77387a962aee05b1bcf17029`）、Bun **1.4.4** 與 OpenCode SDK **2.1.4**。WSL 專用 Hermes profile 位於 `~/.local/share/wisp/hermes`。Windows 桌面連到 WSL 時使用另一個客戶端資料目錄。Git Bash 的 `wisp status` 仍查 Windows 安裝。

## 一個任務如何交付

| 元件 | 負責的工作 |
| --- | --- |
| Hermes Agent | 提供 Electron／React 桌面、Webapp、對話、profile、登入、Skills、MCP 與原生 `/goal`。 |
| Wisp 啟動器 | 選定介面及 profile，提供安裝、診斷與離線 smoke。5090 的設定讓 Windows 視窗連到 WSL 後端。 |
| wisp-core | 在原對話提供 `wisp_propose`、`wisp_status` 與任務面板。Python／FastAPI 處理批准版本、檔案範圍、請求預算、驗收、套回和備份。SQLite 保存任務、事件及收據。 |
| OpenCode | Bun 載入官方 SDK，在核准範圍內讀取、搜尋與編輯候選副本，並請求執行獲准的驗收命令。Wisp 在 Linux 隔離環境執行命令。 |
| 模型供應商 | 任務卡保存選定的模型與來源。WSL 主程序可使用同一 profile 的 OpenAI API 或 ChatGPT／Codex 訂閱。API key 由主程序使用。 |

開發者在原對話檢查任務卡，批准可讀檔案、可改檔案與命令。工作者產生候選後，可看 Diff 和測試結果、退回修正，或接受並確認套回。Wisp 在套回前核對檔案內容，並保存可供重開查看的結果。單一任務可列最多 64 個文字檔，合計 2 MiB。[操作方式與限制](../wisp-opencode-workflow.md)

## 已有的驗收證據

| 環境 | 操作與結果 |
| --- | --- |
| 5090 WSL2，真實模型 | 在 Hermes 0.23.2，由受委託的操作者建立小型範例任務。OpenAI API 的 `gpt-6.2-sol`（High）用 4 次模型請求將 `percent.py` 的上限從 99 改為 100。檢查退出碼 0，任務接受後套回成功。重開 Windows 原生視窗可讀回同一任務的 Diff 和套回結果。 |
| 5090 WSL2，離線 | 在 Hermes 0.23.3 上，Git Bash 的 `wisp smoke --offline` 使用真實 OpenCode 工作者、Linux 隔離與 4 個模擬模型回應。修改前檢查退出碼 1，候選與套回後皆為 0。另一個程序讀回相同任務、Diff 和套回收據。 |
| 另一台 Ubuntu，實際專案副本 | Knowledge Hub 閱讀紀錄搜尋案例經過退回修正，40 項測試通過，5 個檔案套回，重開後讀回結案結果。[Ubuntu 案例與功能比對](../wisp-feature-comparison.md) |

合併前，在 5090 上取出 Git 暫存區的 Wisp 原始碼，於 WSL2 跑過 110 項開發流程回歸、61 項啟動與安裝回歸，以及 18 項桌面與 OpenCode SDK 測試（17 項桌面、1 項 SDK）。Windows 安裝腳本的自動測試使用攜帶版 PowerShell 7.4.20。已安裝版與待提交版本各自跑通同一個離線範例，兩次建置的預覽 ZIP 也逐位元相同。

## 5090 的桌面啟動設定

下表保存已使用的啟動方式，WSL 路徑以目前使用者的家目錄解析。適用環境已有 Windows 的 `Hermes.exe`、名為 `Ubuntu` 的 WSL2 發行版、`~/.local/bin/wisp` 和專用 profile 的 Hermes systemd 使用者服務。這組範例由使用者配置，標準安裝包仍使用其預設入口。

| 原始碼 | 啟用後的位置及用途 |
| --- | --- |
| [git-bash.bash](../../wisp/examples/windows-wsl/git-bash.bash) | Windows Git Bash 的 `~/.config/wisp/git-bash.bash`，由 `~/.bashrc` 載入以選擇桌面或 smoke 等命令。 |
| [git-bash-router.bash](../../wisp/examples/windows-wsl/git-bash-router.bash) | Windows 的 `%LOCALAPPDATA%\Wisp\git-bash-router.bash`，由安裝器建立的 Git Bash 入口載入。 |
| [launch-wsl-desktop.ps1](../../wisp/examples/windows-wsl/launch-wsl-desktop.ps1) | Windows 的 `~/.config/wisp/launch-wsl-desktop.ps1`。取得本機一次性視窗票證後啟動原生桌面，使用 `%LOCALAPPDATA%\Wisp\desktop-wsl-client`。 |
| [hold-desktop-gateway.py](../../wisp/examples/windows-wsl/hold-desktop-gateway.py) | Ubuntu 的 `~/.config/wisp/hold-desktop-gateway.py`，在專用 gateway 運行時維持 WSL 工作階段。 |

## 接下來需要實際驗收的情境

- **日常工具**。用已授權的信箱讀取指定郵件，經同意回覆，並在原郵件串核實送達。
- **互動式小改動**。在 5090 新對話以自然語言提出需求，讓 Wisp 自行提出任務卡，再追加第二輪細節並驗收同一份成果。
- **依 Goal 開發**。逐項確認成品、框架、方法、測試與預期結果，核對本人批准前的行為，再驗證 Wisp 按同一版規格交付。新 Goal 的範圍以使用者提供的文件為準。
- **跨裝置與新安裝**。另一台乾淨 Windows 機重建這套組合，以及 iPad 經授權私人連線操作同一任務，均待實測。5090 現行介面只監聽本機。
