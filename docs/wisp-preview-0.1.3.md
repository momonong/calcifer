# Wisp 0.1.3：交付範圍與驗收界線

日期：2026-11-17（Asia/Taipei）。本文件是公開版本說明，不包含私人試驗帳本或對話。

## 產品方向

Wisp 以 Hermes 為底座，讓日常討論、整理文件與開發共用入口。沿用原生對話、工具、Skills／MCP 接點及資料機制；已交辦的工作可持續完成，新工作與擴大範圍須先確認。主動整理與提出建議，不等於自動開始新工作。

模型與完整 CLI 執行器分開看待。現階段可以使用 ChatGPT/Codex 供應商；產品不以該帳號作為唯一身分。更換供應商時，需另驗證主模型、輔助模型及 fallback，不能只以選單存在就宣稱完全可替換。agy、Quota Broker 或 OpenCode 接入不在本次 Git 交付的已驗收能力內。

## 已包含的內容

| 部分 | 交付內容 |
|---|---|
| 啟動 | Python／PowerShell 包裝器；`wisp` 開啟本機官方 Webapp |
| 安裝 | 固定 ZIP 雜湊驗證、候選版本檢查、原設定復用與同名入口保護 |
| Windows | PowerShell／CMD／Git Bash 共用設定；固定 Hermes 引擎獨立準備 |
| 診斷 | `version`、`doctor`、`status`；`prepare` 明確準備官方介面 |
| 網站 | 公開安裝說明、下載與校驗資料；不提供遠端私人聊天服務 |

固定引擎為 Hermes 0.23.1，commit `72c880370ff2e47dd587982ddded1b1ce90cfde4`。新的 profile 由本人登入；不複製其他安裝的認證。資料分離不是作業系統沙箱，Hermes 工具仍有執行帳號的權限。

## 目前證據與限制

- Windows 使用者已回報：獨立引擎準備、Wisp 安裝、Webapp 建置、doctor、基本對話及立即重開同一對話成功。
- 模型連線與對話結果來自使用者提供的畫面；不代表代理能遠端操作該 Windows 裝置。
- Windows 檔案建立、真實修改、退回修正與人工驗收尚待完整流程測試。
- 原生 Hermes Desktop 存在，但本版本 `wisp` 仍開啟 Webapp；Wisp 桌面入口與捷徑未完成驗收。
- 同一對話的歷史讀回不等於跨對話長期記憶；立即重開也不等於跨日驗證。
- 停止回覆不等於外部程序已終止；關閉分頁不會自動停止 gateway 或背景工作。
- 本次不 fork Hermes、不接 OpenCode，不啟動 Phase 1 或新增模型任務。

`wisp/README.md` 同時是固定 0.1.3 ZIP 的內容，保留封包發布時的驗收描述。較新的人工回報以上列狀態為準，不能為更新說明而覆寫同一版本的 ZIP。

## 重建與本機檢查

不需要安裝 Python 第三方測試依賴：

```sh
python3 -B -m unittest discover -s wisp -p 'test_*.py' -v
python3 -B wisp/build-release.py --out .tmp/wisp-public-build
```

PowerShell 測項需要既有 `pwsh`，或設定 `WISP_TEST_PWSH` 為已安裝的執行檔位置；缺少時會 skip，不能算通過。Linux portable PowerShell 的合成測試不能取代原生 Windows 人工驗收。

Build 輸出只包含明確列出的入口程式、說明、manifest 與安裝腳本。`__ZIP_SHA256__` 是來源安裝器的建置佔位符，公開腳本由 build 注入正確值。網站來源位於 `wisp/site/`；部署時保留既有固定版本下載與其他服務。

## 本次版本核對

50 項 Wisp 合成回歸測試通過，無 skipped；Shell／JavaScript 語法與 diff 檢查通過。既有 Calcifer 程式與依賴檔保持原樣，CLI help smoke 通過。未重跑未修改的整套 Calcifer 測試。

公開網站及安裝材料共 11 檔與來源／重建結果逐位元一致，因此本次不需要額外部署。完整公開摘要見 [驗證紀錄](wisp-0.1.3-validation.json)。

## 下一個接受條件

在新的空資料夾完成一個離線小頁面：先確認目錄與範圍，再授權寫檔、實際操作、退回一次修改、重開同一對話並讀檔接續，最後記錄使用者驗收。未測項目保留未測，不自動擴大到其他專案。

官方參考：[Hermes Agent](https://github.com/NousResearch/hermes-agent)、[Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)。Wisp 是獨立入口，不是官方 Hermes 發行版。
