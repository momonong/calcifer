# M4：固定 JSON CLI 執行驗收（0.0.5）

M4 保留 `node-data`，新增 `node-json-cli` 的公開輸入輸出合同。固定合成 sum CLI 原本把加法寫成減法；產品 adapter 真正執行基線並觀察正常 exit 0 的值錯誤，再由兩官方 SDK 的腳本化 mock worker 各自 read/edit，host 用原三 cases 接受相同整合 artifact。這是合成 CLI bug 回歸證據，不是使用者 repo 已修好、真模型自主推理、內部函式呼叫來源或所有輸入都正確。

## 固定 host 定義

`host.checks[id]` 接受：

```js
{
  kind: 'node-json-cli',
  entryPath: 'entry.mjs',
  cases: [
    { id: 'positive', input: { a: 2, b: 3 }, expected: 5 },
    { id: 'signed', input: { a: -4, b: 7 }, expected: 3 },
    { id: 'zero', input: { a: 0, b: -6 }, expected: -6 }
  ],
  caseTimeoutMs: 1000,
  timeoutMs: 5000,
  maxOutputBytes: 8192
}
```

只允許單一 basename `.mjs`，必須已在 host `sourceFiles` 與 `readPaths`。cases 為 1–4 個唯一 ID，未知欄位與越界在 worker 派送前拒絕；模型只能選既有 checkId。host 定義與 expected 會複製並雜湊，不因 worker 改動原傳入物件而改變。最終驗收仍由 `host.finalCheckIds` 決定。

JSON 域只含 null、boolean、string、array、plain object 與安全整數；根深度為 0、最大深度 8、總節點 1024，每份 input/expected 的 JSON 序列化最多 8192 UTF-8 bytes。拒絕浮點、非安全整數、負零及非 JSON 值。使用標準 `JSON.parse`，重複 key 採最後值；沒有新增 parser。輸出亦驗此域，嚴格 UTF-8 解碼，完整 stdout 必須只有一個 JSON 值（前後 JSON 空白可接受）；空、截斷、第二個 JSON、尾隨 log、TAP、binary events 都不能冒充成功。完整值由 host `isDeepStrictEqual` 比較；child 的 passed/status/caseId 沒有驗收權。

## 程序與證據邊界

每 case 使用既有 Linux unshare/bwrap/timeout recipe 建新隔離 child、清空環境、唯讀 runtime、fresh tmpfs；只掛經 hash 核對的 entry 為 `/workspace/entry.mjs`。stdin 只有當次 input，寫入後關閉。沒有掛 source tree、其他任務檔、host expected、registry 或 ledger；固定 argv 直接啟動明確的 host Node，沒有 shell／命令 DSL 或專案依賴樹。

預設每 case 1000ms、全 check 5000ms、所有 cases 合計 stdout+stderr 8192 bytes；host 可縮小但不可增加上限。stderr 只是有界診斷。正常 exit 0、完整管線 close、合法輸出與 host 比較都必須成立；正確輸出後 hang、非零退出、額外 bytes、取消或 flood 都不能通過。cases 循序執行，第一次失敗即停並列 remainingCaseIds。輸出管線未確定關閉時不派下一 case；無法結算會拋出 UNKNOWN，沿用原持久 intent 與封口，不因 Promise 返回或新 run 消除。

check intent 先持久化，再保存 immutable entry、執行 cases 與完成 evidence。證據綁定 entry hash、完整 source manifest、全部 host 定義／expected、protocol（含 adapter source hash）及 Node realpath／binary hash。每個 check 重新核對 runtime binary，非逐 case 重新計算；沒有驗證快取平台。Node CLI launcher 與 Bun caller 都傳明確 Node binary，不把 Bun 的 execPath 當 Node。

`reopenRun`／`reopenGoal` 唯讀核對定義、protocol/runtime identity、保存 entry、journal intent/completion，再由保存的 raw stdout 重算每個 case 的語義與完整 coverage。即使 report/ledger hashes 一致，偽造 passed、改值、缺 case 或換 protocol 仍拒絕。reopen 會讀 runtime bytes 核對 hash，不執行 runtime 命令、CLI cases 或 SDK；不是 native session 恢復，也不清除 UNKNOWN。

現有 node-data 合同不變：固定可信 script 只能把 snapshot 當資料；不允許 eval/import/exec snapshot 或衍生字串。已移除的 node:test event 通路及 legacy `kind:'node'` 不恢復，也不自動轉換。

## 公開 API 與實際驗證

新增固定用途 adapter `json-cli-check.mjs`：`normalizeJsonCliDefinition`／`bindJsonCliDefinition`、`nodeRuntimeIdentity`、`nodeJsonCliProtocol`、`runNodeJsonCliCheck`、`verifyJsonCliDefinition`／`verifyJsonCliEvidence`。既有 collaboration runner、state/journal、task 工具封口及 goal SDK loops 只增加此 check-kind 接點，沒有新 scheduler/RPC/agent loop。CLI 新增固定 `demo --example json-cli`；缺省 `data` 仍跑原案例。

- 新功能定向 10/10（完整 TAP；Node 子命令 exit 未獨立保存），另 CLI 1/1（已保存 exit 0）。涵蓋基線/fix、常數解失敗、嚴格 JSON/UTF-8/domain、fake passed/TAP/binary/partial/trailing bytes、非零退出、timeout、owned child 持有管線、stdout/stderr flood、cancel、RO entry、oracle/其他檔案缺席、pre-worker 定義/路徑/symlink 拒絕、oracle mutation 與語義 reopen。
- 本里程碑唯一完整 `npm test`：121/121、exit 0，fail/skip/cancel 0；包含既有 UNKNOWN/lost-ack/late-tool 的回歸。先前 RED 1 項如預期因未支援 check-kind 失敗；中途測試端漏 import 與誤用 artifact hash 欄名已修正，原紀錄保留本機。
- OpenCode 2.1.4／Pi 1.4.0，同 Bun 1.4.4、明確 Node 22.22.2、synthetic model/task/scope/cases；各 1 planner + 4 worker requests、reserved 2560，三工具 check→read→edit→terminal，之後獨立 host final。不重複模型 check，不做品質／速度／成本排名；模型請求實際為 0，usage/成本 unknown。
- 兩框架基線第一 case 輸出 -1（expected 5，exit 0），修正後全部輸出 5／3／-6，來源保持減法，整合 artifact 改為加法。兩者 manifest 與 accepted artifact hash 相同；[機讀摘要](json-cli-validation-summary-2026-10-30.json) 僅含白名單合成欄位，完整 wire/帳本留本機。

M3 修正前 108/108、之後 affected 6/6，以及 M2 歷史 89/12/2/1 保留原版本與 source scope；不將它們改稱 M4 當前證據。一次性架構 probe 的既有 12/12 可沿用方案可行性，沒有重跑；產品證據以上列新測試為準。

## 尚未支援

這個黑箱合同允許直接依 input 印出正確值；不證明 export function 被呼叫或 node:test assertions 執行。單一自含 CLI 以外的專案依賴／npm／任意 unit-test 框架仍未實作驗證，能力 pending 並非缺授權。CPU/RAM/PID 配額與 seccomp 未證明，既有 `/usr` 等可信 runtime trees 可讀；不宣稱 production hostile-code sandbox。真實模型/服務窗口仍另缺必要授權，原 40 次 smoke 與獨立 25 次 mock cap 不挪用成協作 live 配額。沒有新增依賴、live、服務、UI 或訓練。
