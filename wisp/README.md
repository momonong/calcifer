# Wisp 0.1.3 預覽版

輸入 `wisp`，在預設瀏覽器開啟本機的官方 Hermes Webapp。日常對話、專案與開發工具沿用 Hermes。Wisp 目前提供啟動、安裝與診斷入口，尚未完成獨立的任務批准／合入管理層。

## 使用條件

- 已安裝官方 Hermes；本版驗證基準為 **0.23.1**，原始碼 commit `72c880370ff2e47dd587982ddded1b1ce90cfde4`。
- Linux：Python 3.10+、curl、瀏覽器。Windows：Windows 10/11、PowerShell 5.1+、瀏覽器。
- 安裝新的 Wisp profile 時，安裝器會用官方 Hermes 準備這個 profile 的鎖定依賴與 Webapp；首次需要下載，可能等候數分鐘。明確沿用既有 profile 時不自動重建；若缺少成品，另執行 `wisp prepare`。
- 模型使用自己的供應商帳號與配額。Wisp 安裝不包含免費模型額度，也不會自動派發任務。

尚未安裝 Hermes 時，先依 [Linux 官方安裝文件](https://hermes-agent.nousresearch.com/docs/getting-started/installation) 或 [Windows 原生安裝文件](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native) 完成安裝。可用官方 installer 的 `--commit` / `-Commit` 固定上述版本。Wisp 安裝器不重裝或更新現有 Hermes。

Hermes 0.16.0 沒有本版使用的 `webapp` 命令，不能直接作為此入口的引擎。Windows 已有舊 Hermes 時，可先用隨版本提供的 `prepare-windows-engine.ps1` 在 `%LOCALAPPDATA%\Wisp\` 準備固定版引擎。它只執行官方固定版的 runtime stages，另寫入該目錄的 launcher，不更新原 Hermes、不發佈新的全域 `hermes` 命令，也不搬移登入。需要明確傳入既有 Python 的完整位置；既有 Wisp 設定或無法確認歸屬的資料目錄會使它停止。

這條相容性準備路徑仍待 Windows 實機驗收。新的 Wisp profile 須由本人登入一次。Chromium／Computer Use 選用套件不在這次初始準備內；瀏覽器 Webapp 仍會在 `wisp prepare` 建置。

## 安裝

從 [Wisp 安裝頁](https://momonong.me/sites/wisp/) 下載對應安裝腳本。先下載到本機、檢視，再執行；腳本會校驗固定版 ZIP 的 SHA256。

Linux：

```bash
curl -fL https://momonong.me/sites/wisp/install.sh -o /tmp/wisp-install.sh
bash /tmp/wisp-install.sh
wisp doctor
wisp
```

如果 shell 還找不到命令，使用 `~/.local/bin/wisp`。將 `~/.local/bin` 加入自己的 PATH 即可；安裝器不改 shell 設定。

Windows PowerShell：

```powershell
Invoke-WebRequest https://momonong.me/sites/wisp/install.ps1 -OutFile "$env:TEMP\wisp-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\wisp-install.ps1"
```

Git Bash 可直接呼叫 Windows 安裝器：

```bash
powershell.exe -NoProfile -Command 'Invoke-WebRequest -UseBasicParsing https://momonong.me/sites/wisp/install.ps1 -OutFile (Join-Path $env:TEMP "wisp-install.ps1")'
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '& (Join-Path $env:TEMP "wisp-install.ps1")'
```

這兩組安裝指令擇一執行。先裝好官方 Hermes；若已有 Wisp，直接重裝會沿用原設定與登入所在的 profile。不要為升級刪除資料目錄。

完成後關閉整個 Git Bash／Windows Terminal，再從開始功能表開啟新終端，輸入 `wisp doctor`、`wisp`。只新增使用者 PATH，不改系統 PATH。Git Bash 的 `wisp` 與 PowerShell／CMD 的 `wisp.cmd` 共用同一安裝、設定與登入。Windows 套件仍標預覽，實機驗收另記。

### Windows 第一次使用與接續

1. `wisp doctor` 應顯示 Wisp 0.1.3、已設定的 Hermes 路徑與版本。
2. `wisp` 應開啟本機 Hermes Webapp。已有登入會沿用；新的獨立 profile 由本人依畫面登入，不搬移認證檔。
3. 交辦「請建立今天的三項待辦，先只在對話中整理，不操作其他檔案」，核對能收到正常回覆。
4. 關閉分頁與終端，再開 Git Bash 輸入 `wisp`，應能找回同一對話及剛才的待辦。

若找不到 `wisp`，在新開的 Git Bash 用下列命令直接開啟已安裝入口。這不修改 shell 設定；成功後核對 Windows 使用者 PATH 是否包含該 `bin` 目錄，不要改用另一個 profile 重裝。

```bash
bash "$(cygpath -u "$LOCALAPPDATA")/Wisp/bin/wisp" doctor
```

0.1.3 納入候選探測逾時保護：15 秒仍無法確認版本時保留舊入口，停止安裝。新增 Git Bash 入口也有所有權與 hash 檢查；偵測到其他工具或手動修改時停止，不覆寫。

## 命令

| 命令 | 效果 |
| --- | --- |
| `wisp` | 使用現有 Webapp 成品，開啟官方介面；不發送模型任務 |
| `wisp status` | 查 gateway／Webapp 狀態；不啟動服務 |
| `wisp doctor` | 查設定路徑及 Hermes 版本；不發送模型請求 |
| `wisp prepare` | 準備獨立依賴與官方 Webapp；Linux 每個長步驟最長 20 分鐘 |
| `wisp --no-open` | Linux：在私人終端顯示一次性登入連結 |
| `wisp -NoOpen` | Windows：同上；不要分享或貼到聊天 |

首次使用新的 Wisp profile，依 Hermes 畫面登入自己的模型供應商。關閉分頁不會停止 gateway 或背景工作；本版不提供一鍵終止所有工作的命令。

## 資料與現有登入

預設資料在 Linux `~/.local/share/wisp/hermes`、Windows `%LOCALAPPDATA%\Wisp\hermes`；Wisp 設定在 Linux `~/.config/wisp/config.json`（遵循 XDG_CONFIG_HOME）、Windows `%LOCALAPPDATA%\Wisp\config.json`。原 Hermes home、登入與設定保留。這是設定與資料分離，**不是作業系統沙箱**；Hermes 執行工具仍有該使用者的權限。

若要沿用已登入的獨立 profile，可在首次安裝時明確指定 `--hermes-home` / `-HermesHome`，不複製憑證。還可指定 `--hermes` / `-HermesCommand`、`--desktop-data` / `-DesktopData`、`--webapp-dist` / `-WebappDist`。**重裝會讀取並沿用既有設定，不必重填這些參數，也不呼叫 Hermes 或重建依賴。** 自訂安裝位置仍需指定原本的 `--prefix`／`--config`／`--bin-dir` 或 `-InstallRoot`。明確傳入不同設定時，安裝器停止並保留現況。新 profile 預設只綁定 `127.0.0.1:18767`，停用背景 review，單次 agent 上限 20 turns。沿用的 profile 保持原設定。

同名 `wisp` 命令若不屬於此安裝，或已被使用者修改，安裝器拒絕覆寫。已修改的 release 也會保留。安裝器先驗證候選版本入口可執行，再切換 `wisp`；候選啟動失敗時保留現行命令與收據。這項檢查不代表模型登入或整體介面已驗收。安裝內容沒有 Hermes 原始碼、登入、模型 key、對話或專案資料。

## 回復與排查

- 找不到依賴或介面成品：先 `wisp doctor`，再 `wisp prepare`。只有偵測到官方「尚無已登記的依賴環境」錯誤時才呼叫 `hermes pm repair` 準備該 profile，其他錯誤停止；不執行 `hermes update`。指定預建成品時不重建介面；未指定時，官方工具會使用 Hermes 安裝中的建置快取。
- 首次準備中斷：命令與獨立 profile 會保留，修正錯誤後執行 `wisp prepare`。再次安裝只更新入口，不會自動重試下載或模型工作。
- 瀏覽器未開啟：在自己的終端執行 `wisp --no-open` / `wisp -NoOpen`。連結只用一次，請勿分享。
- 啟動逾時／狀態不明：先 `wisp status`，確認現有程序與任務；不要盲目重啟或重送。
- 想停用 Wisp：移除 Wisp 安裝收據列出的 `wisp` 命令（Windows 另移除其使用者 PATH 項目）；先保留 Hermes home、desktop 及 release 資料。這不會停止已在執行的 gateway，也不會解除原 Hermes 安裝。
- 網站只有公開安裝檔與文件；不託管你的聊天或本機 agent。主機可能保留一般 HTTP 存取紀錄；頁面沒有第三方分析程式。

本專案沿用 [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent) 的官方介面與引擎；Wisp 為獨立入口，並非官方 Hermes 發行版。
