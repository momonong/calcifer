# M3：官方 SDK 的離線 goal 閉環

0.0.4 將 goal → planner proposal → 本機契約/路由 → 官方 SDK 工具迴圈 → M2 artifacts 整合 → host data-only 驗收接通。OpenCode 2.1.4 維持預設，Pi 1.4.0 是明確選項；SDK 確實執行 agent loop，但所有回應均由程序內合成腳本決定，不是模型思考或品質/效率比較。一般生成程式 runtime/unit-test 驗收仍 pending implementation/verification，M3 沒有補上。

## 可重跑入口

```sh
npm run goal:run -- demo --state-root "$PWD/evidence/goal-opencode"
npm run goal:run -- demo --framework pi --state-root "$PWD/evidence/goal-pi"
npm run goal:run -- demo --framework mixed --state-root "$PWD/evidence/goal-mixed"
npm run goal:run -- reopen --state-root "$PWD/evidence/goal-opencode" --run-id <returned-run-id>
npm run test:goal
```

CLI 僅提供固定合成 demo 與唯讀 reopen，壞參數及未完成 exit 非零。Node 啟動一個目的明確的固定 Bun 1.4.4 child，傳入可信 Node 路徑給 M2 checks；沒有 RPC、server 或模型 endpoint。Bun 是可信 host runtime，並非敵意生成程式的沙箱。CLI 摘要只輸出白名單欄位；原始 wire/native transcript/帳本留本機，不能整份公開。

## 狀態、權限與預算

`runGoal({goal,host,plannerProfileId,transport,signal})` 接收可信 host 定義及程序內 mock transport。host 必須固定 source/read/write/check 白名單、profiles、authorization、最終 node-data checks、canonical stateRoot 與 hostNodeBinary；模型只能提出 scope 內的 TaskPlan。單任務合法，最多四任務，沒有強迫分析/驗證代理，也沒有模型 verifier。

第一個 planner request 前已呼叫 M2 `createRunState`，保留 canonical source workspace 的外層 lock/active claim。immutable metadata.kind 為 goal，metadata.plan 是明確型別 `{kind:'goal_request',goal}`，不是假裝已驗過的 TaskPlan；實際 proposal 經嚴格 JSON.parse、M1 validateTaskPlan/router 後另存結果及 hash。無 Markdown stripping、JSON 修復或重試。planner 失敗不派 worker。

外層 ledger 保存所有 model request 與 SDK phase 的 durable intents/completions；planner/worker/續輪共用同一 gate。實際 M2 collaboration 在外層 run 內的私有 nested stateRoot 執行，保留原 task/tool/check ledger；outer workspace claim 直到所有工作及證據完成才釋放。任一層未知均阻擋完成及新 run，不因換 phase/profile/framework/runID 而重設。更換 stateRoot 是 operator 權限變更，不是模型 recovery。

固定 offline policy：mock only、總 25 requests、planner 1、每 worker task 6、每 request 最多 512 output、reserved output ceiling 12800、模型請求單併發、goal admission window 120 秒、request deadline 10 秒。每個實際 lower fetch 都過同一持久 gate，fsync intent 後才呼叫 transport。attempted、admitted、dispatched 與 terminal-confirmed 分開報告；預派送拒絕是已知結果，intent 後未完成/錯誤/取消保持 UNKNOWN。這不是原 40 次 live smoke 的挪用或新 live 授權，舊 guard/protocol 沒有改動。

兩官方 SDK 在 worker cap 耗盡時會回 native error，不能直接把所有 SDK error 都當 UNKNOWN 或 failed。只有 host gate 明列為 intent/transport 之前的固定 budget/window 拒絕，且 SDK、transport、tools 均 settled/closed、沒有未回答 model intent、M2 tools seal/drain 亦成功，才回 M2 已知 failed；goal 保留 PHASE_BUDGET_EXHAUSTED 等明確原因，partial artifacts 不接受。其他 SDK error、timeout、partial/error stream 或 lost ack 保持 UNKNOWN。

strict selfhost adapter 只做既有明列轉換；新 snapshot/model ID 明確 synthetic。兩框架 provider request hook 都注入且 lower wire 強制核對 `chat_template_kwargs.enable_thinking=false`，不只依 Pi reasoning:false 推論。每 request 最多 128 KiB，完整 synthetic wire 最多 4 MiB；保存實際 request/context/system/tool bytes，bytes 不等於 token 或 context 足夠性證明。usage/cache 未明列時 unknown，SDK 合成價格 0 不當成 live 成本。

## 官方 SDK 與 phase 邊界

每個 planner/task 有新 DB/session、固定 phase identity、獨立工具 closure。public provider header hook 綁 phase marker，lower fetch 只接受既有且開放的 phase；缺少、未知或已關閉的 marker 明拒。marker 是身分 metadata，不是 bearer secret。工具權限不取自 mutable activeTask。

SDK import 前清除環境中的 credentials，建立專用 config/cache/session roots；全域 fetch 僅允許固定合成 URL，socket/WebSocket 拒絕。沒有 provider discovery、contextfiles、skills/extensions、內建 shell、MCP、cache warming、compaction 或自動 retry。唯一 worker 工具為 calcifer_tool，JSON 對應 M2 read/search/edit/check；planner 沒有工具。實際工具 call ID 由官方 loop 帶入下一個 wire request，host 沒有自行補 tool messages。

| 接點 | 分類與已用方式 | 維護條件 |
|---|---|---|
| OpenCode.create、plugin、tool.transform、execute context | 公開 SDK/plugin export；移除 builtins、deny-all 後只 allow calcifer_tool | 固定 2.1.4；未 patch core、未用 private fields |
| OpenCode sessions create/prompt/get/wait/export/interrupt | 公開 client；session group 整體仍標 experimental，wait/export 又有 experimental route | native outcome 與 host acceptance 分開；升級重驗 |
| Pi createAgentSession、ModelRuntime、resource loader/customTools、waitForIdle/abort | 公開 SDK/custom tool API；明確模型與空資源設定，保留官方 loop | 固定 1.4.0；不推論跨版穩定 |
| Pi before_provider_request / headers | 公開 extension hook；payload 注入 thinking，headers 綁 phase | request hook 的 throw 可能被 SDK 吞成診斷，硬拒絕放 lower fetch |
| OpenCode 未使用 local-provider 停探測 | public config workaround：明設空 baseURL；2.1.4 source 查核及實測可略過內建 discovery | 不是穩定文件化 disable API，升級須重驗；硬 gate 永遠保留 |

最初僅 models.fetch/snapshot=false 時，正常模型派送 11 次、fetch attempted 14 次，額外三個內建 local-provider 探測均在 lower gate 被拒，實際外連 0。workaround 後正常 attempted=admitted=dispatched=terminal-confirmed=11，額外 fetch 0。沒有接觸那些 metadata 端點，也沒有將其當成可用服務。

worker 完成/取消後，先封 phase admission，等 native loop、transport 及 tool promises 結算，保存證據並關 SDK，才進下一個 task。M2 另行 seal/drain 工具後計算 snapshot。未知工具回覆立即封整個 model gate；SDK 把 exception 轉成普通 error tool message 也不能續派。停止等待、SDK 是否 settled/closed、tools 是否結算、synthetic stream 是否 drained 及 remoteInference:not_applicable 分開保存。超時/終止不代表之前沒有副作用；未結算保持 UNKNOWN。

## 檔案驗收、比較與證據

相同合成 model/plan/initial note/tool scope/caps 在兩官方 SDK 執行；各 1 planner + 5 first-task + 5 second-task requests。first task 搜尋、read、觀察失敗 check、edit；second task 搜尋、read dependency edit、edit、觀察成功 check；最後 M2 對最新整合 JSON 再做必要 host check。每 task 新 context 所需的 read/search 與獨立最終整合 check 是 fixture 明列操作，不是模型自行學會重用或判斷必要性。沒有最終驗收後的 model review。

兩者接受同一 note.txt diff，check 綁最新 manifest、input/script/protocol hashes；mixed demo 的實際 route 會使用兩套 adapter。框架自帶總 context/tools/wire 不強制相同，完整 wire 保留差異；請求數、mock 時間、合成 profiles 能力標籤都不是框架效能排名或模型 suitability 證據。

M2 只執行可信 kind:node-data：固定 host script 把 immutable snapshot JSON 當資料，不 eval/dynamic import/exec 內容或其衍生字串，亦不插入程式碼模板。沒有 worker executable source mount。它只能證明明列檔案內容 predicate，不能證明生成程式 runtime correctness；CPU/RAM/PID quotas、seccomp 及 production hostile-code isolation 也未證明。

`reopenGoal({stateRoot,runID,expected})` 只讀 outer metadata/hash-chain/report、原來源/固定 check、synthetic wire/native evidence 及 inner M2 reopenRun；不建 SDK、不讀寫 native DB、不生成/派送、不自動清 lock 或 UNKNOWN。缺失/截斷、authority/hash/來源變動均 fail closed。這不是 native session resume。

對本階段需求的對應：goal proposal 與路由有嚴格契約；官方工具迴圈有 wire/call ID 與產物；持久預算與 UNKNOWN 有拒派/不重送；完成由獨立 host data predicate 決定；報告保存 exact scope、usage unknown 及人工接受界線。live 條件見 [live gates](live-and-distillation-gates-2026-10-30.md)，UI、服務恢復與訓練未啟動。

修正前唯一完整 `npm test` 為 108/108、exit 0、0 fail/skip，當時包含新 M3 15 項；首輪定向 13/13、其後受影響的 discovery/lost-edit 3/3 與併發/error/cancel 5/5 都保留各自 scope。審查另重現已知預算拒絕被錯列 UNKNOWN；兩框架新回歸先 0/2 RED，最小修正後兩 SDK budget + 必要 partial/error/lost-edit/cancel 共 6/6、exit 0、0 fail/skip，沒有重跑全套。最後 source 的證據是這 6 項，108 不冒充最後 source 全套。[白名單比較摘要](goal-validation-summary-2026-10-30.json) 含 wire/source hashes 與實際 byte counts；原 35/54/89 及 M2 首輪修正均保留歷史 scope，不冒稱模型品質證據。
