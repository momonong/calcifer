# 卡西法遠端工作台（M1）

目前：主機控制層、HTTP 邊界與手機介面已完成本機驗收。正式 HTTPS 開通尚待本次具體部署批准與私人終端密碼設定。`https://workbench.example.com/calcifer/` 是準備中的目的地，不能把此文件當成已上線證明。

本版讓不同裝置接續同一個主機工作階段。主機持有檔案、Playbook、原生 agy／Codex CLI、模型資源批准與測試證據；手機只傳命令和讀取結果。這不把卡西法綁定 Thor：伺服器使用明確的專案登錄表，Thor 是目前選用的既有驗收工作階段。

## 已提供的操作

| 操作 | 行為與限制 |
|---|---|
| 登入、登出／登出所有裝置 | 密碼在主機私人終端設定，登入有效 12 小時；修改密碼撤銷舊登入。沒有登入不能讀取專案或 patch。 |
| 選擇已登錄專案 | 不接受瀏覽器指定任意檔案路徑、shell、供應商憑證。新增專案先由主機建立隔離工作階段，再加入私密設定。 |
| 送出與排隊 | 同專案依序執行；排隊訊息在當前命令結束後才處理，不是對原生 CLI 的即時插話。 |
| 同步進度 | SSE 通知工作階段與完成狀態，重新同步會讀取原生專案狀態。提供最後回覆、模型分配、測試摘要；目前不是原生 CLI 的逐 token 終端鏡像。 |
| 斷線重連 | 關閉頁面不取消工作。命令先保存再執行；相同 UUID 與內容不建立第二筆工作。 |
| 未送達命令 | 本分頁 sessionStorage 暫存待確認命令（含需求，不含登入密碼）；先查原 ID。查無收據時可明確按原編號重送，不自動重送或換 ID。核對後刪除草稿。 |
| 要求停止 | 先記錄取消要求，再取消本機操作；串流是否關閉、工具是否停止、遠端推論是否停止分開顯示。不能把 HTTP 取消當成遠端算力已停止。 |
| 核對未知結果 | 使用原生 task／operation 收據。已知失敗、部分完成與整體成功分開；結果仍未知就保留 UNKNOWN，不自動重做。 |
| 測試、產生 patch | 沿用現有 Python unittest、保護測試與同版本證據；下載須有完成收據，檔案範圍與雜湊仍須吻合。 |
| 批准下一階段資源 | 顯示既有模型池、資料範圍與最多 8 次 CLI 呼叫，使用者填用途後明確批准。登入／重連不增加額度；預設不設整體執行期限，可另填期限。 |

## 主機接入

使用現有 Node 22.22.2，未新增套件或變更 lockfile。

```sh
calcifer remote configure --config /私人目錄/remote.json \
  --origin https://workbench.example.com --project 專案代號 \
  --state /既有隔離工作階段 --label 專案名稱
calcifer remote password --config /私人目錄/remote.json
calcifer remote serve --config /私人目錄/remote.json
```

`configure` 不批准模型、不啟動服務，也不覆蓋已存在設定。設定、密碼 verifier 與 sessions 使用 owner-private 目錄／檔案。密碼透過 `/dev/tty` 輸入，未提供 argv、聊天或日誌輸入方式。

服務只監聽 `127.0.0.1:18470`。生產要求 HTTPS origin、精確 Host／Origin、JSON、CSRF 與 HttpOnly cookie；只允許固定靜態資產及專案 API。登入與命令 body 都有上限。SSE 在登入失效時關閉，慢速 POST 也必須在 body 完成後重新驗證登入。

## 遠端部署

已準備 `deploy/remote/` 中的兩個 user systemd 範本、Caddy prefix 與固定範圍安裝器。公開範本中的 `@GATEWAY_HOST@`、`@REPO@`、`@NODE@`、`@CONFIG@`、`@PATH@` 與 example.com 均需在已授權部署時依實際環境替換，不能原樣啟動。路徑為：

```text
手機／其他電腦 → 既有 HTTPS 閘道 → gateway Caddy /calcifer/
             → SSH 加密連線 → 開發主機 loopback → Calcifer → 既有 CLI
```

沒有租用雲端電腦，也沒有建立新公開 SSH 埠。開發主機必須保持開機與連線；此版不提供主機離線時的雲端代跑、多主機轉移或 SSH 以外的工作搬遷。

Caddy 安裝器要求目前檔案 SHA、單一 operation ID、主機健康檢查及 `caddy validate`，只插入 `/calcifer/` 片段並保留其餘位元組。備份及 PREPARED／reload intent／APPLIED 收據留在 閘道主機私密目錄。若 reload 結果未知，先讀回收據與實際服務；不能換 operation ID 盲目重做。共用網域中的其他應用必須同樣可信；本版不是不同使用者之間的安全隔離服務。

服務單元先落盤而未啟動。正式啟動與 閘道路由套用有獨立部署批准要求；使用者在私人終端設定卡西法密碼及輸入 閘道 sudo 密碼。不要借用 `/sites/`、Quota 或 HTML Preview 的限定部署憑證。

核准開通後的管理命令：

```sh
systemctl --user status calcifer-remote calcifer-tunnel
systemctl --user stop calcifer-remote
```

停止主機服務會關閉其加密連線；已送出而結果未知的工作保留原收據。程式目前由既有隔離 worktree 執行，開通收據另外記錄檔案雜湊；不能把尚未提交的 worktree 說成已發布版本。

## 驗收證據（2026-11-08）

```sh
node --test test/project-*.test.mjs test/calcifer-cli.test.mjs test/remote-*.test.mjs
```

這次 80 項通過，涵蓋原生專案流程、命令持久性、併發去重、登入撤銷、來源保護、取消、未知結果及產物下載。

`test/remote-native.test.mjs` 使用全新合成 Python 專案，透過真實 project API 執行 CPU 測試與匯出 patch；原始來源保持不變。另模擬測試／匯出／資源批准已完成，但控制層尚未保存回覆便中斷，從原生收據恢復而不重做。所有模型呼叫均為零。

實際 Chrome 驗收使用兩個獨立瀏覽器登入、390／768／1440 寬度、原生 CPU 測試、patch 內容、遺失 POST 後重新載入並明確沿用原 ID 重送、登出所有裝置。螢幕截圖與私密驗收收據保存在本機交付目錄。尚未宣稱實體手機、正式 HTTPS 登入或真實模型品質已驗收。

一次獨立審查發現並修正：撤銷時尚未完成的 POST、新命令借用前一 task 結果、已知失敗／部分完成無法解除 UNKNOWN，以及未送達命令造成頁面卡死。新增與修正的驗證只針對這些具體風險。

## 本階段不含

不包括模型品質評比、雲端 GPU／Brev 申請或啟動、MCP／研究工具擴充、複雜多代理介面、多使用者權限、任意 shell、Git 合併／推送或自動發布。這些仍沿用原先的獨立授權與後續階段。
