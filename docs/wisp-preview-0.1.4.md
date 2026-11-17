# Wisp 0.1.4：Ubuntu 桌面版本對齊

日期：2026-11-17（Asia/Taipei）。這是原始碼與本機維護交付，網站下載仍保留 0.1.3。

## 問題與結果

Hermes 後端已更新至 0.23.2，但先前獨立建置的桌面仍是 0.23.1。桌面與終端命令也使用不同入口。0.1.4 新增可選的 Linux 桌面設定，讓設定好的 `wisp` 與應用程式選單指向同一桌面，保留明確的 `wisp webapp`。

| 元件 | 本輪版本與範圍 |
|---|---|
| Wisp | 0.1.4；Python 桌面路由、相容重裝、診斷與發行資料 |
| Ubuntu Hermes | 0.23.2，`ae2a81ccc00e9b7c06301523e5bb09608397149c` |
| Desktop runtime | 官方 lock 固定的 Electron 44.10.2 |
| Node / pnpm | 26.12.1 / 12.15.0，沿用該 Hermes commit 的工具 pin |
| Windows 引擎 | 保留既有 0.23.1 準備腳本；本輪未驗證 Windows Desktop |

設定缺少桌面成品時明確報錯，不偷偷切到另一個 profile。既有沒有 `desktop` 欄位的設定仍開啟 Webapp。新版本安裝會保留選用的桌面設定。

## 可重建方式

以乾淨的官方 Hermes checkout 取得確切 commit；輸出到新的候選目錄，保留舊建置。下列變數須自行設為當前主機的絕對路徑，不能照抄其他裝置的私人目錄。

```sh
git -C "$hermes_source" archive ae2a81ccc00e9b7c06301523e5bb09608397149c | tar -x -C "$desktop_candidate"
cd "$desktop_candidate"
node scripts/build/node-deps.mjs --source "$desktop_candidate" --workspace apps/desktop --reuse
GITHUB_SHA=ae2a81ccc00e9b7c06301523e5bb09608397149c GITHUB_REF_NAME=stable HERMES_PAYLOAD_VERSION=0.23.2 node apps/desktop/scripts/build.mjs
node apps/desktop/scripts/build-webapp.mjs
```

前提：`desktop_candidate` 已建立且為空；PATH 使用上述 Node/pnpm。第一步要檢查管線兩端的退出碼（Bash 可先 `set -o pipefail`）。只用一般 `pnpm install` 不足以準備 Electron 執行檔；應用官方 `node-deps.mjs`。本輪在切換前檢查發現這項缺少，補齊後才繼續。

明確 SHA 避免匯出目錄向上找到 Wisp repo，誤把 Wisp commit 寫進 Hermes build stamp。這是本機建置；使用上游 `GITHUB_SHA` 輸入介面不代表執行過 GitHub Actions。

建置後核對 `apps/desktop/build/install-stamp.json` 的 commit 與 displayVersion、兩個介面的 index、Electron 執行檔以及 `dist/electron-main.mjs`。不要只以 build 成功當成完整安裝。

Wisp 自身封包：

```sh
python3 -B wisp/build-release.py --out .tmp/wisp-014-build
```

解開新 ZIP 至獨立目錄，執行其 `install.py`。它會驗證 manifest 與各檔 hash，保留既有設定。之後依 `wisp/README.md` 的 `desktop` 格式設定候選桌面，保留原 `hermes_home` 與 `desktop_data`。舊版 ZIP、安裝目錄、設定及收據不可覆寫。

## 保留與切換

- 私人 runtime 保存舊命令、config、install receipt、桌面捷徑及一致的 SQLite 備份；不進 Git。
- 原 Hermes 認證與設定不搬移、不改寫；只核對必要 metadata。
- 先確認沒有活動任務並正常退出舊桌面，再切換 Wisp 設定及捷徑。
- 僅在載入新版 Webapp 所需時重啟 Wisp 的既有專用 gateway；不安裝全域服務。
- `.desktop` 的 Exec 指向 `wisp desktop`，視窗識別匹配來源版 Hermes；圖示沿用官方資產。
- 退回時先正常退出新桌面，再恢復同一備份組的 config、命令、receipt 與捷徑；保留原 profile。桌面與後端仍須版本相容，不能將退回入口宣稱為後端降版。

## 驗證界線

58 項 launcher／installer 回歸通過（35.407 秒），包含既有 portable PowerShell 7.4.20 測項，沒有 skipped。涵蓋空白／中文路徑、profile 環境隔離、候選失敗、成品缺少、早期程序失敗、明確瀏覽器入口及重裝保留設定。獨立審查發現桌面環境覆寫缺口後，先重現失敗，再加入清除 `HERMES_DESKTOP_*` 的修正與 11 種控制值的回歸；複核已關閉問題。這不是 Windows 實機 Desktop 驗收。

Ubuntu 新版桌面與 Webapp 已建置、版本 stamp 正確。`wisp --version` 為 0.1.4，`wisp doctor` 的桌面與後端均為 0.23.2，桌面捷徑語法檢查通過。這是固定官方原始碼的獨立 Electron 建置，沒有另發一個 Wisp AppImage。

使用者已確認「視窗、原專案與對話正常，版本是 0.23.2」。資料庫核對保留原兩個專案，原驗證對話的訊息、工具及 API 計數不變。原全域與 Wisp profile 的認證／設定 metadata 未變；舊建置、舊 releases 與回復備份均保留。

切換 gateway 時，官方 restart 首次回報外部 supervisor 沒有重新拉起。核對舊程序已退出後，正常啟動新版桌面，由官方桌面恢復本機 gateway；未重送任務或建立全域服務。沒有藉維護重跑原 40 項 Knowledge Hub 測試或新增模型交辦。模型品質與 OS 通知未在本輪重驗。

本輪不 fork、不接 OpenCode、不改正式 Knowledge Hub，不進 Phase 1。網站部署與 Git 合併是不同動作；本次沒有更新網站下載，也不覆寫 0.1.3 封包。
