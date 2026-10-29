# 卡西法（Calcifer）選型決策

更新：2026-10-30（Asia/Taipei）。當前決策：OpenCode 維持主選、Pi 保留對照；已授權在 host 核准 profiles 內自動路由及分段協作開發，取代先前人工 profile only／不做協作的限制。0.0.2 完成 [協作計畫](docs/collaborative-development-plan-2026-10-30.md) Milestone 1 的離線契約與 mock 規劃；0.0.3 接續完成 [M2 的本機隔離協作原型](docs/milestone-2-isolated-collaboration-2026-10-30.md)。可信 mock worker 與 namespace check 仍不代表真模型協作能力或成本已驗證；live mode 不可用，正式 UI 繼續暫停。

目前 M2/M3 驗收只採可信 data-only check；一般生成程式 runtime／unit-test 驗收尚未實作與驗證，不是缺授權 blocked。真實模型/服務窗口仍缺必要授權。node:test 事件判定曾被二進位事件偽造繞過，已移除並拒絕 legacy node kind。

| 驗收項目 | 本版可證明 | 狀態與限制 |
|---|---|---|
| 檔案協作與資料驗收 | 相依 snapshot/artifact 整合、固定 host script 解析 immutable JSON 並比對明列內容 | node-data；不執行 worker 可編輯程式 |
| 一般程式 runtime／unit tests | 尚無可靠受測程式執行驗收合同 | pending implementation/verification；不能宣稱修 bug 正確 |
| OpenCode／Pi 比較 | 下列歷史單模型 scripted mock 工程證據 | 未變成新協作模型品質/成本證據 |

以下 10/26 研究與單模型比較保留為歷史背景；涉及「不做自動路由／多代理系統」的舊限制以本段及協作計畫為準。原模型 UNKNOWN、資源上限、無付費 fallback 與服務授權邊界仍適用。

10/26補充研究推薦「薄任務／成果工作台」，具體場景、責任邊界、模型設定檔、建造順序與未決問題見 [產品方向提案](docs/product-direction-2026-10-26.md)。這不是已批准的 UI 架構。官方版本與工作台介面重新核對見 [上游研究](docs/upstream-workbench-research-2026-10-26.md)；未升級套件、未新增生成或重跑充分同版測試。下列歷史階段的「未操作Git」只描述當時，10/26已另獲完成成果合併推送授權。

10/26 的歷史階段曾採明確設定檔、不做自動路由，當時只補 selfhost 離線缺口。已新增嚴格 adapter、持久 model request UNKNOWN／40 次共享預算、獨立 read/edit/test 與合成 SDK 驗證，證據見 [離線準備報告](docs/offline-preparation-report.md)。40 次真實生成額度本輪未消耗；服務恢復、現場精確 model/revision/context/deadline 核對與實測窗口另行確認，正式 UI 繼續暫停。

10/25–10/26 的歷史同版完整驗證 **35/35 通過**（含第一輪 characterization 回歸及新增 selfhost SDK／unit），完整輸出與 source/profile/fixture/lock hashes 見報告；下列13/13及舊收據保留為第一輪歷史證據。

## 結論

**保留 OpenCode v2.1.4 為條件式主選，Pi v1.4.0 為可替換對照。尚無足以證明 Pi 在相同完成品質下更有效率的證據，也尚未完成 OpenCode 的正式採用驗收。**

兩套都有公開客製介面。本輪真正要守住的風險是「已送出但結果未知」：正常完成、取消、斷流及重啟的語意不同，不能只靠一次 retry 設定或 session resume 推定不會重送。若這個要求最後必須大幅修改 OpenCode 核心，應重新比較 Pi；本輪不直接擴張核心改造。

## 第一輪 characterization 的歷史結果

`npm test`：**13/13 通過**；兩框架各 12 個 scripted mock 案例，共 24 個。正式 SDK、provider parser 與 agent loop 真正執行，沒有用自寫 agent loop 替代。CLI 僅版本 smoke。這證明有限範圍的工程接入，不證明真實模型的自主工作能力。

公開證據見 [衍生驗證摘要](evidence/offline-validation-summary.json) 與 [離線報告](docs/offline-preparation-report.md)。原始完整收據、歷史失敗日誌及中間run保留本地，沒有公開；摘要包含原始hash及目前source hashes，不能替代完整trace。10/26核對同版19項hash後沿用35/35結果，沒有重跑測試。

| 比較面向／案例 | OpenCode 2.1.4 | Pi 1.4.0 | 判讀 |
|---|---|---|---|
| T1 小修改 | 2 次 accepted request、1 次工具；只改 note.txt | 相同 | 固定腳本的範圍與工具回填通過 |
| T2 bug | 3 次 request、2 次工具；五項邊界檢查 red→green | 相同 | edit 工具同步回傳 regression 結果；不是自主推理證據 |
| T3 未知工具結果 | 2 次 accepted；公開 HTTP hook 擋住 2 次；副作用 1 次 | 2 次 accepted；4 次 dispatch 嘗試，其中 2 次由較下層 mock gate 擋住；副作用 1 次 | ledger／gate 是本地應用政策；只測 clean close/reopen，不含硬 crash 或模型 POST UNKNOWN |
| 工具與不完整回覆 | 未宣告工具、截斷 arguments 均未執行；斷流回報錯誤 | 相同 | 受控合成工具集合通過，不等於一般 shell sandbox |
| 503／明設 retry | retry off 只送 1 次；指定 retry 案例共 2 次 | 相同 | 未將此結果推及所有 transport／recovery 分支 |
| length | 自動續寫，共 2 次 request | 1 次，停在 length | retry=false 不等於所有續寫都停；第二回已明列 fixture |
| hook 拒絕 | http.request throw：dispatch 0 | before_provider_request throw：dispatch 1 | Pi 此 hook 不能直接當硬 gate；不等於 Pi 完全不能實作 gate |
| 取消 | client abort 被觀察、未 drain；工具未開始、遠端 unknown | 相同 | 沒有驗證執行中工具停止或真實遠端取消 |
| headers／payload／上限 | header marker 可見；公開 model limit 使實際 output cap=512；任意 context options marker 未透傳 | header/body marker 可見，output cap=512 | 不能把 hook 被呼叫當成任意 payload 相容已驗證 |
| 額外 context（T1） | systemChars=1507 | systemChars=137 | 本輪客製設定下的字元數，不是 token／品質／成本勝負 |
| 真實正確性、工作效率、介入、API 成本 | pending／unknown | pending／unknown | 無授權的真實模型試驗未執行 |
| 實際維護面 | 公開 SDK/plugin adapter、permissions、Bun runtime | 公開 SDK/extensions adapter、下層 gate 需求 | 共用 fixture/receipt；本輪沒有核心 patch |

兩套共用同版 Bun 1.4.4、同初始合成資料、同 mock model／回覆、同工具 schema、每案最多 3 次 accepted mock requests、每案 30 秒，以及實際輸出上限 512。各自額外 context、事件與完整 payload 保存在未公開的本地原始JSON。較早 run 的 cap 不一致、spawn 欄位矛盾及局部失敗已保留，不作最終對等比較證據。

OpenCode SDK 在本機 Node 22.22.2 匯入出現 `SyntaxError: Unexpected identifier '_'`，使用上游固定版本宣告的專案內 Bun 1.4.4 後通過；沒有修改全域 Node。OpenCode 另嘗試 3 個 localhost discovery URL，全部被 mock 拒絕，沒有 socket 外送；不能把 `models.fetch=false` 當作零 discovery 嘗試。

目前可重跑入口：

```sh
npm ci --no-audit --no-fund
npm test
# 單獨產生新收據（不執行 assertions）
npm run spike
```

安裝需要 registry 網路與套件 lifecycle script 權限；測試需要建立隔離子程序，本機沙箱內的 EPERM 不代表 SDK 測試通過。測試期間只使用 in-process mock，無 provider 網路需求。完整執行與範圍見 [README](README.md)、[實作說明](docs/spike-implementation.md)、[鎖檔](package-lock.json)。


## 版本與可重現邊界

| 項目 | 固定基線 |
|---|---|
| OpenCode | `anomalyco/opencode`，`v2.1.4`，`68bc26b7da1990ce10ffecfbc1e09eb13aa5d824` |
| Pi | `earendil-works/pi`，`v1.4.0`，`4a080252f06caf63a525d7873c5d94d3c23887e0` |
| Calcifer 起點 | `82a0ec1a2e9a395dfdd521f30e4c6c41997ab451`；離線階段保留於 `feat/harness-spike`，10/26另依授權進行Git交付 |
| 資料／模型 | 合成 fixtures，沒有真實模型端點、帳號或付費 API 實測 |
| 平台 | Linux x86_64；實際 runtime 與 lockfile 身分見 run 證據 |

OpenCode v2 的套件是 `@opencode/sdk`、`@opencode/plugin`，不使用舊 `@opencode-ai/*` API。SDK、plugin 與 native client 的版本一起鎖定；原網站文件仍可能出現舊介面，以本輪固定 source 和已安裝型別為準。[SDK 套件](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/package.json)、[SDK README](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/README.md)

## 公開客製介面與維護取捨

下表是固定版本的原始碼查核。實際執行通過的範圍以本文件的驗證結果與 evidence 為準，API 存在不等於已驗收。

| 能力 | OpenCode v2.1.4 | Pi v1.4.0 | Calcifer 的責任 |
|---|---|---|---|
| Prompt／context | 公開 plugin `prompt`、`context` hooks | 公開 extension `before_agent_start`、`context`、`context_with_system` | 保存額外 prompt/context；同一任務共用工作規則 |
| 壓縮 | 公開 `compaction` hook；背景壓縮為 experimental | 公開 `session_before_compact`；可取消或提供摘要 | 本輪避免隱含摘要請求；摘要保真與成本另驗 |
| 工具新增／限制 | 公開 `tool.transform`、`execute.before/after`、context tools | 公開 `customTools`／`registerTool`、allow/deny、`tool_call` | 最小顯式工具集合；不得把 prompt 當 OS sandbox |
| 操作批准 | 公開 `permission.evaluate`／`permission.assert` | 公開 `tool_call` block；host 提供批准 UI | 非互動且缺批准時拒絕；拒絕不得有副作用 |
| Provider／headers／payload | provider 設定＋`model.request`／`http.request` | models/provider 設定＋headers/payload hooks | 依端點契約轉換；不宣稱泛用 OpenAI-compatible |
| Retry | 公開 retry hook，但有前置 recovery 路徑 | agent retry 與 provider retry 分開設定 | 記錄 dispatch 次數；未知結果先 reconcile |
| 取消／完成 | interrupt 接受後仍需 wait／終態事件 | abort 等 idle；`agent_end` 不等於 `agent_settled` | 分別顯示停止等待、drain、工具與遠端狀態 |
| Session／UI events | 公開 session/inbox/context；durable session.log 為 experimental，一般 event.subscribe 不重播 | 公開 session tree、subscribe、session manager | 將資料持久化與遠端副作用結算分開 |
| 需要核心 patch？ | 本輪不修改核心；完整安全覆蓋尚待證明 | 本輪不修改核心；完整安全覆蓋尚待證明 | 不能由「目前零 patch」推論正式產品永遠零 patch |

OpenCode 介面依據：[session hooks](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/plugin/src/promise/session.ts)、[tools](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/plugin/src/promise/tool.ts)、[permissions](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/plugin/src/promise/permission.ts)。Pi 介面依據：[SDK](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/sdk.md)、[extension 型別](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/extensions/types.ts)。

## UNKNOWN 與恢復：不可省略的選型門檻

OpenCode 的 admission ID 可去重，但相同 ID 的後續 prompt 仍可能喚醒 execution；它也不檢查兩次 payload 是否相同。原生 restart 明載 at-least-once，SDK 開啟時會自動恢復；`RecoverFull` 路徑先於一般 retry hook。因此 `retry:false`、相同 message ID 或持久化 DB，都不能單獨保證不重複外部副作用。[admission](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/session.ts#L155-L185)、[restart](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/execution/restart.ts#L35-L61)、[RecoverFull](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/runner/step.ts#L182-L203)、[SDK startup](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/internal/host.ts#L53-L56)

對 OpenCode 可評估的最小限制是 **sessions API＋HTTP transport＋受控工具**，在公開 `http.request` hook 外送前檢查持久 operation 狀態；不能只用 payload hash，因為恢復時 prompt 會變。收到 headers 尚未代表串流完整。WebSocket 走 experimental hooks，無 session 的 `generate.text()` 不經相同 session hook，其他 plugin 的任意網路也不受此 gate 保證。[HTTP／WS 路徑](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/model-request.ts#L314-L365)、[generate 路徑](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/generate.ts#L65-L75)

Pi 的 agent retry 預設啟用，會將部分 timeout／stream-disconnect 視為可重試；本輪需顯式關閉 agent retry、provider retry、隱含壓縮及 cache warming。固定版本的 provider retry wrapper 實際預設為零，不能把原廠 SDK 註解的預設兩次當成 Pi 實作。`setActiveTools()` 也不是完整權限撤銷，codemode/deferred/MCP 要另管；本輪不載入這些額外能力。[retry 設定](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/settings-defaults.ts)、[provider wrapper](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/ai/src/utils/provider-retry.ts#L99-L125)

Pi `before_provider_request` 的 handler error 會被 extension runner 記錄並繼續，不可用 throw 當強制拒絕的保證。要做 provider gate，需在確實擁有送出權限的 wrapper 或傳輸層實現並測試；mock fetch 拒絕只是測試安全網，不能當成原生能力。[extension runner](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/extensions/runner.ts)

## 成本與效率應如何判讀

| 指標 | 本輪可得資料 | 不能得出的結論 |
|---|---|---|
| 正確性／必要驗證 | 固定 fixtures 的可觀察斷言與執行紀錄 | 真實模型能自主理解所有需求 |
| 時間、回合、工具呼叫 | scripted mock 的工程診斷 | 哪個 harness 做事較快／比較省 |
| input／output／cache usage | 本輪未注入 usage chunk；原生零值為缺省，非實測用量；非零 usage/cache 解析 pending | 真實模型 token 數或 cache 命中率 |
| API 成本 | 真實成本 `unknown`；本輪未呼叫付費推論 | 缺 usage／價格資料就當零 |
| 人類介入／策略調整 | 真實模型試驗 `pending` | 預寫腳本反映模型會自行改假設 |
| 維護成本 | 本輪 adapter、設定與相依範圍可點數 | 尚未整合的 production gateway／UI 已可維護 |

後續若授權真實模型，固定同一 provider、model revision、參數、工具能力、預算、任務與初始 workspace；記錄兩框架自己的 context 與壓縮差異。每任務先固定驗收及必要檢查，將未完成／失敗保留於同一 cohort；品質不相等時不以低 token 或少工具呼叫宣告勝出。先做每框架每任務一次小樣本，只有具體失敗假設或新變更才追加驗證。

## 近期變動與升級風險

OpenCode 官方 changelog 顯示 v2.1.4 為 2026-10-23：相關變更包括 MCP elicitation 修復、compaction 超限處理、背景 compaction（experimental，未採用的摘要仍會耗 token）；v2.1.3 涉及 custom baseURL precedence。Pi v1.4.0 為 2026-10-21：修復 compaction 輸出上限、恢復 extension tools、截斷 tool-call 後的 transcript，以及調整 provider attribution 與 retry。這些都會影響本輪關注的行為，升級後應重跑對應 fixtures，而不是默默跟 latest。[OpenCode changelog](https://opencode.ai/changelog)、[Pi release](https://github.com/earendil-works/pi/releases/tag/v1.4.0)

## Claude Code 的參照角色

官方說明將 Claude Code 的工作循環描述為取得 context、使用工具、驗證並調整；也區分模型與包住模型的 harness。最佳實務強調提供可執行的成功判準與根因驗證。這支持我們測試「完整工作方式」，不構成 Claude Code 效率勝出的證據，也不能推論換 Claude 模型即可重現全部體驗。本輪未使用 Claude Code CLI、帳號或額度。[工作循環](https://code.claude.com/docs/en/how-claude-code-works)、[官方最佳實務](https://code.claude.com/docs/en/best-practices)

## 卡西法最小 UI 建議（待確認，未實作）

保留一個工作區、一個 session 主畫面：

1. **工作區與 session**：顯示 repo／分支、初始狀態、任務及完成條件；可開啟既有 session。
2. **工作時間線**：訊息、工具輸入／結果、必要驗證與終態；可查看精簡失敗原因及原始證據。
3. **批准與停止**：明確的 approve／deny；停止後分列等待、串流、工具及遠端狀態。UNKNOWN 先核對，不能出現一鍵盲重試。
4. **成果與交付**：範圍 diff、通過／失敗／未驗證、可重跑命令；驗收滿足就結束。
5. **端點與模型**：顯式選擇已授權的 provider/model，設定引用安全憑證位置；不自動切換付費模型。
6. **用量摘要**：顯示可取得 usage 與有依據的成本；unknown 原樣保留，不做完整成本平台。

工作規則留在 harness/host：固定驗收、必要驗證、充分證據重用、相同失敗改假設、嘗試／資源上限、能力批准、UNKNOWN gate、無付費 fallback、到完成條件即停止。UI 負責呈現與接收決策，不能是唯一政策執行點。本輪不建立通用策略引擎、驗證快取平台或多代理系統。

## DGX Spark 與既有自架服務

維持 **開發機執行 agent、檔案、Git、shell、測試；Spark 僅提供推論 API**。本輪未連入 selfhost-models，也沒有將歷史部署狀態當作現況。將來接入前先讀當時的 API/client-integration 契約並確認端點授權。

Spark 實機能力全部 `pending`：容量須計入權重、量化額外資料、KV cache、context、batch/併發及系統保留；不可由參數量單獨推定可用。ARM64／Blackwell、driver/CUDA、serving image digest、模型 revision、量化格式、tokenizer/chat template、tool parser、stream/usage/finish reason、context 長度與併發均須固定並實測。另驗證取消／斷線後遠端是否仍跑、如何查詢 request 狀態，以及開發機到 Spark 的認證與連線中斷行為。官方資料確認 Spark 的 Grace Blackwell／Arm 平台與統一記憶體，但不代表任何指定模型在目標併發下合格。[硬體資料](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)、[軟體資料](https://docs.nvidia.com/dgx/dgx-spark/software.html)

## 待決資訊與停止點

真實模型比較需要集中確認：**provider／endpoint、完整 model ID/revision、允許的合成資料與工具副作用、請求/token/時間或費用上限、安全憑證取得位置，以及取消／查詢狀態契約**。不在聊天貼入憑證。

10/25離線階段交付後停止，當時未提交、推送、合併、發布或部署。10/26依新授權完成研究規劃與Git交付；服務恢復、精確現場模型與實測窗口仍需另行確認，正式 UI 繼續暫停。研究文件中的下一階段建議不構成執行授權。
