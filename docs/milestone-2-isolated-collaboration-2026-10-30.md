# Milestone 2：離線隔離協作契約

0.0.3 實作 1–4 個明列任務的順序協作；兩個相依編輯是驗收案例，單一小修改不必強迫拆分。OpenCode 保持主選，Pi 保留對照；M2 使用 host 注入的可信 mock worker，尚未接官方 SDK worker 或模型 planner。generation 計數固定為 0，不借用或擴張既有 live 額度。

## API 與 host 權限

`runCollaboration({ plan, host, worker, signal })` 先沿用 M1 的完整 plan/路由驗證，再建立持久 run。host 明列 canonical sourceDir、固定 stateRoot、sourceFiles/readPaths、allowedPaths、allowedCheckIds、finalCheckIds、checks、profiles、authorization。sourceFiles 是既有文字檔的精確白名單；allowedPaths 必須是 readPaths 的子集，不能建立新檔。worker 結果只能是 `{ status: 'completed' }` 或 `{ status: 'failed' }`，不能授權路徑、命令或提供可信 hash。

最終驗收必須取自非空 `host.finalCheckIds`。task.checkIds 只縮小任務可要求的 check 工具，省略它不能省略最終驗收。host checks 只支援可信 mock evaluate，或 `{ kind: 'node-data', scriptPath }`；不接受任意 executable、argv 或 environment。node-data 腳本由 host 讀取並保存到 run 內獨立目錄；check 作者的可信契約是只處理 snapshot data，不對 snapshot 或其衍生字串 eval/dynamic import/exec，也不插入程式碼模板。模型不能提供 check 程式。legacy node kind 已拒絕且不自動轉換，沒有執行 worker 可編輯程式的驗收入口。definitionHash 包含固定 script hash、data protocol 與限制，派送前重驗。

`hostNodeBinary` 是可選的可信 Node 絕對路徑；native Node host 可用已識別的本身執行檔。Bun caller 必須明確提供可信 Node 路徑，不把 Bun 的 process.execPath 冒充 Node。這個 runtime 選擇納入 authority hash。

worker 收到 task 複本、profileId、tools、signal 與工作目錄供可信 host code 使用；沒有真實模型 context。後續 SDK adapter 不得把 source 路徑、state root 或此 host 工作目錄資訊當成模型權限。注入函式本身是可信 host code；它能呼叫 Node API，因此不宣稱此函式已在 hostile-code 沙箱執行。

## 快照、受控工具與整合

source 只讀取精確白名單，不覆寫。每個 task 有獨立 snapshot，初始內容加上所有已驗收的 transitive dependencies；不會讀到無關 sibling 產物。host 依實際工作目錄計算 diff，拒絕新增、刪除、未授權修改、symlink、非 regular file；可寫檔 hardlink 亦拒絕。產物帶 before/after hash。

預設上限為 16 個檔案、單檔 16 KiB、合計 128 KiB、每次工具輸出 32 KiB、每 task 32 次工具；host 只能縮小上限。支援 UTF-8 的 txt/md/json/js/mjs/cjs/ts，拒絕無效 UTF-8、NUL 與其他檔案類型。所有路徑都用標準相對檔名，逐段拒絕 symlink；不是目錄前綴或 glob 授權。

唯一 JSON 工具入口為 `tools.dispatch({ action, args })`：

- read：args 必須完整且只有 path，限制在 host readPaths。
- search：args 必須只有非空 query，按 literal 搜尋允許檔案，輸出有界並標示 truncated。
- edit：args 必須完整包含 path、expectedHash、content；限制在 task.writePaths，過期 hash 拒絕。串行處理、同目錄原子替換、檔案及目錄 fsync 後回覆。
- check：args 必須只有 checkId，限制在 task.checkIds，執行 host registry 的固定定義。

worker 回傳、失敗或取消後即 seal 工具入口，晚到呼叫回報 TOOLS_CLOSED。已接納的 serial queue 必須結算後才計算 task snapshot；未結算或遺失結果保持 UNKNOWN。UNKNOWN 會立即終止 admission：新呼叫及已排隊但尚未開始的操作都拒絕，不能 catch 後再 check/edit；原 unresolved intent 保留。正常 lifecycle seal 仍允許先前接納的 queue 結算，這與 UNKNOWN 的 terminal gate 不同。這不是只用 Promise.race 就假定 worker/工具已停止。

最終整合重新從 initial snapshot 套用已接受 artifacts；before hash 不符即 ARTIFACT_CONFLICT，不能最後寫入者覆蓋。相依編輯可依序合成，獨立任務改同檔會衝突。未通過的工作目錄保留供檢查，產物不接受。最終 checks 綁定整合 manifestHash 與 check definitionHash；檢查失敗、期間修改內容或證據過期都不能 completed。結果仍只保存在 run 內，來源及無關檔案保留原狀。

## 持久狀態、UNKNOWN 與唯讀重開

`createRunState({ stateRoot, sourceDir, metadata })` 的實際時序是：取得以 canonical source 目錄 hash 為 key 的 workspace lock，唯讀核對既有 active run，再建立 exclusive immutable metadata、ledger start，最後原子保存 active reference。metadata 綁定 planHash、authorityHash、固定 assignments、initial manifest、workspace/run/ledger 身分與 mock provenance。M2 是驗完 plan 才呼叫此 API，沒有 planner 生成前預留額度的泛化入口。

回傳 metadata、runDir、append、finish、release；ledger 每筆帶序號、前筆 hash 與身分，append/fsync 後才派送。task intent 記 task/profile/input manifest；task 內 check/edit/read/search 有子 intent/完成紀錄。這是串行 task intent 包含工具事件的粒度，任何未回答 task 或子工具都保守拒絕後續整合。

`readRunState({ stateRoot, runID, expected })` 只讀 metadata/ledger/report；`reopenRun` 另核對 initial、已接受 task、integration 與 check 腳本證據。expected 可指定 authorityHash、planHash、workspaceID、ledgerID。缺 ledger、截斷、hash/身分不符或過期完成證據均 fail closed；重開不寫入、不派送、不解除 UNKNOWN。

同一 source 在固定 stateRoot 有 active record；換 runID/plan/profile 不會繞過未知 run。lock 不自動清 stale；沒有 resume/retry/reset/reconcile 入口。取消前未派送不產生持久副作用；執行中停止等待與 worker/tool 是否結算分開回報，mock 的 stream drain／remote inference 為 not_applicable。可信 worker 忽略 signal 時可仍在 host 內執行；工具封口與 UNKNOWN 會防止接受/重派，但不是任意 JS 的強制終止保證。

## 可信 data-only check 執行邊界

父層在二進位 node:test 事件也能被受測 child 偽造後，已明確縮小本版驗收範圍。舊父 driver/wrapper 已移除；不再堆疊 stdout、event、nonce 或來源欄位當可信完成證據。一般生成程式 runtime／unit-test 驗收尚未實作/驗證，是能力 pending；不是缺執行授權造成的 blocked，也不是 data-only 通過即可宣稱完成真實修 bug。M3 同樣只整合此資料驗收合同，不會補 runtime 能力。

`runNodeDataCheck({ inputPath, scriptPath, expectedInputHash, expectedManifestHash, ...limits })` 只執行固定可信 host script。runner 在 check intent 持久化後，保存 `{ schemaVersion: 1, manifest, files }` 的不可變 JSON；files 為 path→content，manifest 含每檔 hash/bytes 及穩定整體 hash。驗收前後核對 input bytes/hash/manifest，結果及最終 report.checks 明列 `kind:'node-data'`，綁定 inputHash、manifestHash、script definitionHash 與 node-data protocol。`readNodeDataInput` 是相同的唯讀資料核對入口，reopen 亦核對；舊 node kind/協定證據拒絕。

Linux adapter 沿用已完成的 namespace 證據。外層 unshare 建 user+net namespace；內層 bwrap 使用隔離 namespaces、cap-drop ALL、disable-userns、die-with-parent 與 new-session。只掛 readonly runtime trees（/usr、/lib、/lib64）、明確 Node binary、單份 readonly `/input/snapshot.json` 及 readonly `/check/check.mjs`；不掛 `/workspace` 或任何 worker 可編輯的 executable source。建立新的 /proc、最小 /dev 與 tmpfs /tmp，清空 environment，不掛 host home、host /etc、host temp 或 state root。

固定 check 可以使用標準 Node 程式解析 JSON、比對文字等資料條件，其 exit status 是可信 host 程式的結果。來源中的 process.exit、TAP 或 V8 serialized-event 程式碼都只會是 JSON 字串；不會進入 JS parser 或被匯入。這個可信作者契約不能靠宣告取代程式審核：host script 若對 snapshot 或其衍生字串 eval/dynamic import/exec，或插入程式碼模板，就越出合同，模型不能把這種腳本加入 registry。

host check wall clock 為 50–5000 ms，stdout/stderr 合計最多 32 KiB；TERM 後有 KILL 升級，PID namespace 會處理其後代。工具/權限或 namespace 不可用時 CHECK_ISOLATION_UNAVAILABLE，沒有無隔離 fallback。runtime trees 若原含秘密仍可能可讀，未做全機秘密掃描；CPU/RAM/PID 配額、seccomp、kernel exploit resistance/DoS 防護未證明，不能稱 production hostile-code sandbox。沒有修改 cgroup、OS policy、網路或服務。

## 重跑與證據界線

```sh
npm run test:collaboration
node src/collaboration-run-cli.mjs demo --state-root "$PWD/evidence/collaboration-runs"
node src/collaboration-run-cli.mjs reopen --state-root "$PWD/evidence/collaboration-runs" --run-id <returned-run-id>
```

CLI 只接受固定合成 demo 或唯讀 reopen，不把 JSON 轉成任意 JS/命令。輸出 JSON，completed exit 0，其餘 exit 1；provenance 固定 mock、generations 0。raw ledgers、run IDs、完整輸出及本機位置只留 gitignored evidence 或本機暫存，不放進公開報告。M3 planner/SDK 接線、真模型品質/成本、live、正式 UI、訓練及部署都未啟動。

審查前版本曾通過 M1+M2 定向 54/54、完整 npm test 89/89。第一次修正後 12/12、2/2、1/1 也確曾通過，但其 node:test 完成邊界仍被二進位事件偽造繞過，不能聲稱第二項 P1 已解除。本版已改成可信 data-only 合同；最後 source 的受影響驗證是 data-only adapter/協作 6/6、CLI/legacy-kind 拒絕 2/2，均 exit 0、0 fail/skip；沒有重跑全套。所有歷史都是離線合成證據，不能代表新的 source、runtime coding correctness、live 或人工接受。
