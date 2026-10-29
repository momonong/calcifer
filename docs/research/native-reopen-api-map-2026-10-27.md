# 原生安全重開 API 對照（公開研究摘要）

本稿為 2026-10-27 公開衍生摘要，保留固定官方來源與研究結論；私人原稿保留，公開包不含其位置或執行識別。原研究與本次包裝都沒有執行 runtime 或新增測試。主契約見 [safe-reopen-contract](safe-reopen-contract-2026-10-27.md)。API能力不自動授權操作；尤其host已死時，主契約先停在唯讀checkpoint，不能把下列初始化能力當作無副作用查詢。


## OpenCode

查核：2026-10-26 至 2026-10-27（Asia/Taipei，跨午夜）；固定 `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`。沿用 `docs/upstream-workbench-research-2026-10-26.md`，本次僅補重開契約，不重做版本／選型。本次只有讀檔與固定官方 source 查核，未建立 SDK instance、執行 CLI／server／測試、呼叫模型或探測服務。本節是研究材料，不是已實作或已驗收。

### 結論

**可在仍存活的受控 host 上重新連線、讀回 session 與待辦；不能以公開 Promise SDK「先唯讀開啟舊 DB、確認後才恢復執行」。** `OpenCode.create()` 在回傳 handle 前已 fork 自動 recovery，公開 CreateOptions 沒有 `readOnly`、`start:false`、`resume:false` 或 `recovery:false`。prompt 的 `resume:false` 只管該 admission，不管 startup。UNKNOWN／host restart 必須在 create 之前完成 host 所需的判定與外送保護；若條件不足，公開 SDK 沒有可宣稱安全的「先開再看」模式。本報告不提出繞核心或直接改 DB 的替代。

**本地 execution 成功、idle、事件水位和 provider／工具遠端結果是不同權威。** OpenCode 沒有本研究可據以確認遠端 UNKNOWN 成功／未執行的 API。本次guard原碼查核已確認的 ledger「completed 後、SDK response 投影前」窗口，也不能靠重新 prompt 消除。

### 介面名稱與穩定性

下表使用 `@opencode/sdk` Promise 入口回傳 handle 的 `session`，`sessions` 是同一 client alias；`events` 是 `event` alias。**permission 在 handle 頂層 `permission.*`，不是 `session.permission.*`。** Effect 入口部分 sessions 方法改接 core，勿混用回傳型別。來源：[Promise SDK aliases](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/promise.ts#L20-L67)、[Effect aliases](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/effect/opencode.ts#L19-L58)。

「公開」表示生成 client 確實暴露該方法，不表示穩定性保證。整個 session protocol group 描述仍是 **Experimental session routes**（[session group](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L840-L844)）；下表另標出 URL 明列 `/experimental/` 的方法。core 的 `SessionExecution.resume`、`SessionStore.listSuspended` 是內部服務，不能捏造成公開 `client.session.resume()`。

| 讀回需求 | 實際公開 Promise API／欄位 | 權威與限制 |
| --- | --- | --- |
| Session metadata | `session.get({sessionID})` → Info；`session.list(...)` → `{data,cursor:{previous?,next?}}` | Info 的 `id,parentID?,projectID,location,metadata?,outcome?,time.{created,updated,idle?,viewed?,archived?}`；outcome 是 **最後完成 execution** 的結果，不是當下 running status。[Info schema](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/session.ts#L32-L59)、[list/get protocol](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L117-L133) |
| 是否本程序仍在執行 | `session.active()` → record，值 `{type:"running"}`；`session.wait({sessionID})` → void，POST experimental wait | active 是本程序 foreground drain ownership；wait 只等本程序 idle，不啟動工作，也不保證未來沒有排隊工作／遠端操作。[active protocol](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L211-L231)、[ownership/wait contract](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/execution.ts#L17-L39) |
| 訊息／上下文 | `session.message.get({sessionID,messageID})`；`session.context({sessionID})` → message[]；`session.export({sessionID,sanitize?})` → `{info,messages}`（experimental） | context 只有最後 compaction 後的 active context；export 是 projected transcript，不是原始 DB／遠端 receipt。[context](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L508-L517)、[export](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L197-L209)、[message client](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/client/src/promise/generated/client.ts#L1019-L1030) |
| 尚未投遞的工作 | `session.inbox.list({sessionID})` → item[] | 持久、依 enqueue sequence 排序；`id,sessionID,time.created,type,payload,delivery:"steer"|"queue"`；type 是 user/synthetic/compaction/move。已 promotion 的項目不再留在 pending list，**缺席不等於未接收／已完成／已取消**。[pending-only contract](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L546-L568)、[inbox schema](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/session-inbox.ts#L11-L76) |
| 待批准 permission | `permission.list({sessionID})`；`permission.get({sessionID,requestID})` | Request：`id,sessionID,action,resources,save?,metadata?,source?,message?`；source tool 有 `messageID,id`。只反映當前 instance 記憶體 pending Map。[實際 client 名稱](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/client/src/promise/generated/client.ts#L1662-L1694)、[request schema](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/permission.ts#L17-L42)、[Map/close](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/permission.ts#L117-L133) |
| 待回答 form | `session.form.list({sessionID})` → Info[]；`session.form.get({sessionID,formID})` → Detail | Info：`id,sessionID,title,metadata?,fields`；Detail 多 `state:{status:"pending"|"answered"|"cancelled",answer?,message?}`。list 只列 pending；記憶體 cache，pending 無 TTL、terminal 保留 10 分鐘；不是跨 host 待辦 storage。[form API](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L735-L776)、[form state](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/form.ts#L126-L170)、[cache](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/form.ts#L106-L115)、[retention](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/form.ts#L8) |
| 已持久化事件 | `session.log({sessionID,after?,follow?}, {signal?})` → AsyncIterable（experimental） | 只有 durable session events + `log.synced`；細節見下段。[log API](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L665-L680)、[client shape](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/client/src/promise/generated/client.ts#L984-L1007) |

metadata／message／inbox／context 的讀取不初始化 plugins；permission／form list 需要取得 session instance，可能觸發插件 setup，故「GET」不等於完全無初始化副作用。讀 pending 應在受控 host／instance 條件成立後進行。[官方 SDK read boundary](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/README.md#L61-L74)、[permission instance acquisition](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/handlers/permission.ts#L60-L66)。

### 三條重開路徑

| 路徑 | 可讀與可判斷 | 不可推導／禁止自動行為 |
| --- | --- | --- |
| 正常完成、host 尚存活 | 讀 Info.outcome/time.idle、active、message/context/export、inbox；必要時 wait 後重讀。durable `session.execution.succeeded/failed/interrupted` 是本地 execution terminal，包含整個 coalesced busy period。 | 舊 outcome 可能屬前一次 execution；不能單靠 succeeded 宣稱任務驗收或所有外部副作用已 reconciliation。不要為「打開任務」補送 prompt。 |
| UI／HTTP／event transport 斷線，host 仍活著 | 重新建立 client／subscription，使用已保存 sessionID；補 log、重讀 metadata/inbox/current pending permission/form。host 自己持有 agent loop。 | AbortSignal／SSE iterator return 取消的是 client request／subscription；不是 session.interrupt。prompt 回覆遺失時 admission 可能已成功；不能把斷線當未接收。 |
| UNKNOWN 或 host restart | 舊 DB 能保留 session、投影、inbox、execution claim；若 events.persist=true，能補 durable log。host 身分／原 ledger／外送保護由主契約先核對。 | create 自動 recovery，可先於任何讀回執行；恢復是 at-least-once，不能保證不重複外部副作用。permission/form 舊 ID 不能作跨程序持久批准，必須查當前 pending，舊回答不可自動重播。UNKNOWN 不能被「新程序 active 空」或「idle」解除。 |

Execution terminal schema 含 `session.execution.started/succeeded/failed/interrupted`；failed 有 `data.error`，interrupted 有 `data.reason:"user"|"shutdown"|"superseded"|"inactivity"`。shutdown interrupted **不更新** Info.outcome/time.idle，且保留 execution claim；因此 stale outcome 是明確契約，不是 UI 猜測。[event types](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/session-event.ts#L244-L263)、[projectIdle shutdown exception](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/projector.ts#L418-L445)、[claims/terminal](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/execution.ts#L73-L77)。

### 哪些呼叫不是單純讀回

- **`session.prompt({...,id,resume:false})`** 仍會持久 admission、初次準備 prompt／hooks，可能 commit staged revert；只禁止此次 wake。預設 resume 非 false 會 wake。**即使相同 id 已成功 admission／promotion，返回既有項目之後仍會 wake**；first-admission-wins 也不是比較 payload 後的重新確認。應用不能將同 id 重送當 GET。[prompt reconcile then wake](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/session.ts#L155-L185)、[first admission wins](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/inbox.ts#L163-L175)。
- `session.inbox.update({sessionID,inboxID,delivery:"steer"})` 喚醒 execution；改 queue 不 wake。cancel 只刪未投遞項目，沒有項目時是 no-op，不取消已執行工具／模型。[inbox actions](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/session.ts#L136-L153)。
- `session.synthetic` 預設可 wake；`session.compact` 排入 compaction 並 wake；`session.command` 執行 command handler；`session.shell` 執行 shell。這些都不能用於 UI reconnect。[synthetic/shell/compact protocol](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L396-L454)。
- `session.generate({sessionID,prompt})` 雖宣稱不變更 session history，仍做模型生成，不是讀取。[transient generation](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L647-L660)。
- `permission.reply({sessionID,requestID,decision:"once"|"always"|"reject",message?})` 會釋放等待工具；always 有 save 時寫入 project saved approvals，並重新評估同 instance 其他 pending，可能一併放行。reject 會拒絕同 session 其他 pending；**reject 附非空 message 刻意形成 ToolFailure，讓模型繼續**，不得拿來作停止。[permission continuation/batch scope](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/permission.ts#L238-L312)。
- `session.form.reply({sessionID,formID,answer})`／cancel 都 settle Deferred，等待者可繼續。cancel 不是 agent cancellation；close 取消所有 pending forms。[form reply/cancel/close](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/form.ts#L180-L227)。
- `session.interrupt({sessionID,resume:false})` 停本程序 active work；回 `{interrupted:boolean}` 只表示接受中斷，cleanup 還在進行。需要 settlement 時再 await `session.wait`。**resume:true 會喚醒 steering 與 next-in-line compaction/move，queue 留待後續**；預設不 resume。idle interruption 是 no-op，不能清除未知的遠端副作用。[interrupt protocol](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/protocol/src/groups/session.ts#L685-L701)、[interrupt implementation](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/execution.ts#L150-L170)。
- `close()` 先 abort 所有由 host 管理的 HTTP requests，再 dispose runtime；不等於「永久取消此 session」。graceful shutdown 的 execution claim 刻意保留供下次恢復。[OwnedFetch.close](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/internal/fetch.ts#L35-L44)、[shutdown keeps claim](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/execution.ts#L125-L132)。

### Log、cursor 與重連

1. **必須事先明設 `events:{persist:true}`，且 DB 持久。** server 將 persist 選項直接交給 Bus，Bus 預設 false；未保留 payload 時仍有 projection／aggregate sequence，不能見到 `log.synced` 就宣稱完整歷史可重播。晚開 persist 不會補回已丟棄事件。[server wiring](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/routes.ts#L116-L120)、[persistence default](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/bus.ts#L179-L208)、[conditional insert](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/bus.ts#L418-L437)。
2. durable event envelope 是 `{id,created,type,durable:{aggregateID,seq,version},data,metadata?,location?}`；cursor 取 `event.durable.seq`。marker 是 `{type:"log.synced",aggregateID,seq?}`，空 aggregate 沒有 seq。**after 是 exclusive、同 aggregate 的 sequence，不能用 event ID／timestamp／session-list cursor，也不要自行加一。**[cursor schema](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/event.ts#L16-L34)、[durable payload](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/event.ts#L90-L116)、[synced schema](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/event-log.ts#L8-L22)。
3. follow=true 先訂閱 durable wake，再抓 watermark；先讀所有 `seq > after && seq <= watermark`，送一次 log.synced，再讀新 commit。query 按 seq 升序。這避免單次 stream 在 replay→live 之間漏事件；**不提供跨連線 exactly-once UI delivery**。[exclusive ascending reads](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/bus.ts#L770-L809)、[replay to live](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/bus.ts#L834-L875)。
4. 應用保存「已成功套用」cursor；斷線用同 aggregate 的最後 cursor 重連，若 cursor 保存落後，事件可重複。以 event.id 或 aggregateID+seq 做冪等套用屬應用責任。未知 event types 會跳過但 raw tail seq 前進；session stream 會濾掉非 session durable events，故 seq 可能不連續，marker 可超過最後顯示事件。**不要將 gap 當丟包，也不可把 marker 當業務 terminal。**[skip unknown types](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/bus.ts#L793-L809)、[session log filtering contract](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session.ts#L173-L180)、[filter implementation](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session.ts#L435-L443)。
5. `event.subscribe()` 是 live-only，source EOF／錯誤會結束 subscriber；沒有自動重連。每 subscriber backlog 上限 4096，超過會錯誤結束；新訂閱只有目前 connected marker。generated `session.log` SSE 同樣只 fetch 一次，忽略 SSE id/retry 欄位，沒有 Last-Event-ID 自動恢復。RequestOptions.signal 直接給 fetch。[SharedEvents lifecycle](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/client/src/shared-events.ts#L24-L57)、[overflow/new subscriber](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/client/src/shared-events.ts#L90-L115)、[generated fetch/SSE](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/client/src/promise/generated/client.ts#L291-L429)。
6. token text／reasoning／tool-input delta、tool progress，以及 permission/form events 是 ephemeral，不在 durable log 補播範圍。應依投影與目前 pending 重建，不能復原所有當時畫面。metadata get 與 log 是不同 API，**本次未找到原子 snapshot+log-cursor API**，故不能宣稱隨意「get snapshot 後補 log」已無競態。[delta durability](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/session-event.ts#L397-L457)、[tool progress](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/session-event.ts#L481-L538)、[permission events](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/permission.ts#L45-L54)、[form events](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/schema/src/form.ts#L173-L177)。

### Startup／shutdown 的必要先後與能力缺口

**Startup source 順序：** instance selector 建好 → runtime.contextEffect → 註冊 options.plugins → fork resumeSuspendedSessions → 建 handler／transport → 回傳 handle。未提供停用 recovery 的 CreateOptions。[公開 Promise options](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/promise.ts#L20-L24)、[完整 ServerOptions](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/options.ts#L6-L47)、[embedded host boot](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/internal/host.ts#L30-L69)。

登記 plugin 不等於全部 setup 完成：register 只將定義存入 Map 並通知；cold instance 在 capability／recovery 時構造。instance.configure 不可依賴尚未回傳的 handle。selected-instance plugins 會等待 activation，所選 plugin 失敗則 capability acquisition 失敗；一般 awaitActivation 本身是等待，不是所有插件健康成功的保證。不能把事後 `await opencode.plugin(guard)` 當 startup guard。[registry only](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/plugin/sdk.ts#L28-L39)、[selected-instance readiness/failure](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/src/internal/instances.ts#L64-L92)、[activation contract](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/plugin/service.ts#L9-L34)、[SDK lifetime guidance](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/sdk/README.md#L70-L76)。

**推論給 host 契約：** 原 ledger 可讀性／身分一致性、UNKNOWN 判定、預算狀態與外送 gate 應在呼叫 create 前完成，能被復原 instance 同步取得；不得依賴 create 後首次 API 查詢才關閉外送。即便外送 gate 拒絕模型，recovery 仍可能執行本地恢復步驟／工具；此研究不將模型 gate 擴張成所有工具副作用阻擋證明。公開 SDK 無純讀 DB 模式就是目前缺口，不以私有 layer override 或直接 DB 修改冒充受支援方案。

**Shutdown source 支持的邊界：** 若目的是停止而非下次續跑，應先封鎖新 admission／外送，再對已知 active session interrupt(resume:false)、wait settlement、讀回 terminal／pending，最後 close；這是 host 流程要求，並非已實作證據。即使這套流程成功，遠端 UNKNOWN 與 receipt reconciliation 仍需獨立保留。單純 close／host crash 都不能清除恢復權利；restart source 明說 at-least-once，恢復可加入 synthetic restart notice 並直接 execution.resume，預設每 turn 最多 10 次恢復的內部限制並非共享模型預算。[restart contract](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/execution/restart.ts#L23-L61)、[durable attempt/notice](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/execution/restart.ts#L77-L99)、[recovery resumes](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/execution/restart.ts#L192-L230)。

### 未驗證／與host契約整合

本輪是固定 source 契約核對，不證明現有 Calcifer host 已完成上述接線；沒有進行 restart／reconnect／plugin failure／cursor persistence 測試。未設計新的 broker、UI 或私有 core 替代。Host契約承接：原 ledger 與 DB 的綁定、缺 ledger fail-closed、已 completed 但 response 尚未投影的窗口、單 runner 的 admission／shutdown 序列。**保留 OpenCode 主選，但安全重開屬條件式，不能標成已通過。**

方法備註：兩個猜測的 client 入口路徑 404，隨即改用固定 commit 已取得 tree 的正確 `packages/client/src/promise/` 路徑；未用其他版本填補。所有上方連結皆為同一固定 commit。



## Pi

2026-10-26 至 2026-10-27（Asia/Taipei）。固定 `earendil-works/pi@4a080252f06caf63a525d7873c5d94d3c23887e0`；只核對已安裝 docs/types/source map 與同 commit 官方 source，沒有 import/執行 SDK、建立 AgentSession、啟動 CLI/RPC、測試、模型或服務。本稿是原始碼契約分析，不是 recovery 執行驗證；不更動選型。

**結論：Pi 可讀回 finalized transcript，原程序存活時可讀 live 狀態，但沒有內建「跨程序的模型請求收據＋pending approval＋事件重播」原子恢復契約。重開畫面不得以 prompt、Agent.continue 或 compact 代替讀回。** `get_entries({since})` 確實存在，是 durable transcript entry cursor；「沒有 event replay」不能誤寫成「沒有任何持久 cursor」。

### 三條路徑

| 路徑 | 可用 API／權威資料 | 邊界與 host 必須保留的判斷 |
| --- | --- | --- |
| 正常完成，原程序尚在 | SDK `session.subscribe`；`agent_settled {aborted}`；`session.waitForIdle()`；`session.messages`；`session.sessionManager.getEntries()/buildSessionContext()`。RPC `get_state/get_messages/get_entries/get_tree`。 | `agent_end` 不是整個 run 結束；retry/compaction/queued continuation 可接著執行。`agent_settled` 是 run 的終界，並不等於成功／工具外部副作用已核實／任務驗收；仍讀訊息 stopReason/error 與 Calcifer receipts。[A1][A2] |
| UI 網路斷線，但受控 host 與 Pi 原程序仍在 | 保持既有 RPC stdout 持續讀取；重連後在同一 session 讀 `get_state` 的 `sessionId/sessionFile/isStreaming/isCompacting/pendingMessageCount`，再讀 `get_entries({since:lastEntryId})`＋`leafId`、`get_messages`。四個 get handler 只讀 getter，不呼叫生成。[R1] | UI transport 不是 Pi 的 stdio transport。不能因瀏覽器離線就關閉 Pi stdin／重啟子程序。snapshot／event 不是原子讀取；先維持 live 訂閱，再 reconciliation。丟失的 token delta／tool progress／dialog event 不會由 entry cursor 補回；missing acceptance response 仍可能已送模型，禁止盲重送。 |
| Pi／host restart，或 provider 結果 UNKNOWN | 先綁定原 task、sessionFile/sessionId、原 guard ledger；確認既有非空合法檔，再 `SessionManager.open(path)`＋`getHeader/getEntries/buildSessionContext`。只還原 transcript，不啟 runtime／生成。 | `open` 對 missing／空檔會建立新 session，故不能不驗證路徑就當唯讀恢復（下文）。native transcript 沒有模型請求 operation ID 的權威執行結果；absence 不證明未執行，presence 也不與 guard receipt 原子提交。approval／queue／run狀態沒有已找到的跨程序權威恢復 API。UNKNOWN 應保留給既有 guard/receipt reconciliation，不能從最後訊息角色自動推導重送。[M1][M2][A3] |

`isStreaming` 在本版代表整個 active run **包含 post-run continuation**，不是單純 token stream；SDK `isIdle` 的實作是 `!_isAgentRunActive && !isCompacting`。RPC 沒有獨立 isIdle 欄位，但同次 `get_state` 的兩旗標皆 false 可表示該瞬間相同 idle 條件；它不證明先前請求成功、沒有 UNKNOWN 或任務已完成。`pendingMessageCount` 是 queued user messages，不是 approval 數量。[A1][R2]

### 精確 API 與 read／run 分界

| API | 本版方法／欄位與行為 |
| --- | --- |
| `SessionManager.open(path, sessionDir?, cwdOverride?)` | `session-manager.ts:1766–1785` 依檔案 header/cwd 建 manager；本身不派送模型。**不是無條件唯讀**：1031–1053 對空檔寫新 header、missing 路徑建立新 session，constructor 也可 mkdir（1008–1013）。既有非空合法 transcript 的正常讀取路徑不生成。 |
| `getHeader/getSessionId/getSessionFile/getLeafId/getEntry/getBranch/getEntries` | Header 1505–1507；identity 1152–1157；leaf/entry 1404–1413；active branch 1464–1478；全部 raw entries 1515–1522（不含 header，含已離開的分支／compaction前歷史）。可用來核對固定 task/session identity。 |
| `buildContextEntries()/buildSessionProjection()/buildSessionContext()` | 1481–1499：active leaf 的 compaction-aware context；最後者回 `{messages,thinkingLevel,model}`，**只建立資料，不傳模型**。不要將 active context 當完整歷史。 |
| `createAgentSession({sessionManager,...})` | `sdk.ts:191–211,403–478` 讀 manager context，將 messages 放入 Agent initialState，還原 model/thinking/tools；核心函數沒有自動呼叫 prompt/continue。會建立 settings/model runtime、預設 reload resources，並可能補寫 model/thinking metadata；不是 read-only reader。extensions 載入／bind lifecycle 具有執行能力，host guard 與受控 resource loader 仍須生效。[S1] |
| `SessionManager.continueRecent(cwd,sessionDir?)` | 1793–1800 只挑最近 session，找不到就建立新的；名字的 continue **不表示送模型**，但不適合固定單任務的 identity selection。CLI `--continue` 對應此方法；`--resume` 是選擇 session 再 open（main.ts:415–433）。啟動 CLI 本身仍有資源／extension lifecycle，本輪不啟動。[M1][C1] |
| `AgentSessionRuntime.switchSession(path,options?)`／RPC `switch_session` | runtime source196–223：emit before-switch（可cancel）→open新manager→abort舊run→shutdown/dispose舊session→createRuntime→rebind→可選withSession。核心不自動 continue，但會中止／替換原run、執行 lifecycle；**不是 UI reconnect 只讀動作**。[X1] |
| `AgentSession.prompt(text,options?)`／RPC `prompt` | 生成入口；可能先處理 extension slash command/input hooks、展開模板；active 時依 streamingBehavior queue。`steer/followUp` 也可能使現有 run 多送模型。讀回時不可呼叫。[A4][R3] |
| 低階 `Agent.continue()` | `packages/agent/src/agent.ts:392–419` 延續 transcript 到 agent loop；last assistant 時有 queue 可派送 queue，否則throw；last user/tool result 可開始新請求。不是 attach/resume reader，不可用於 UNKNOWN 自動恢復。[L1] |
| `compact`／automatic retry／overflow continuation | RPC compact 呼叫 `session.compact`（rpc-mode533–535），可能派模型作摘要；AgentSession postrun1900–1908可呼叫agent.continue。應受既有 outbound gate 控制，不能只攔 UI prompt。[A2] |

Pi public RPC command union (`rpc-types.ts:20–74`) 沒有 `resume`／`continue` wire command，也沒有讀 pending approvals 或 replay events 的 command。不要發明這些介面；SDK 有低階 Agent.continue，不等於 RPC 支援。[R2]

### prompt acceptance、settled 與取消的陷阱

1. **SDK prompt promise 不一律是 run completion。** `AgentSession.prompt():Promise<void>` 只有實際開始新 run 才 await `_startRun`；handled／queued 分支會提早 return（2092–2174）。在 `agent_settled` handler 內呼叫也先 deferred/return（2093–2095）。`preflightResult` 是給 RPC 用的 internal hook（311–325），不是建議 host 採用的新 durable admission API。[A4]
2. **RPC success 是 preflight disposition。** `{type:"response",id,command:"prompt",success:true,data:{disposition:"started"|"queued"|"handled"}}`；rpc-mode394–413 非同步啟 run，preflight後失敗不再發第二個 command failure。`handled` 不應等待此 prompt 專屬 settled，extension 可自己發模型或有別的活躍工作。session events 沒有通用 request id／run id 可直接與 response join。[R3][R2]
3. **acceptance 不是 durable receipt，且不是最早外送點。** `_startRun` 先 `_prepareRun`（1878），後 `onStarted`（1890），再 `agent.prompt`（1899）。`_prepareRun` 的1931可能先 auto-compaction。因此「尚未收到 started」不能證明零外送；收到 started 也不保證 user message 已持久化。[A2][A5]
4. **訊息事件與 disk 不原子。** `_handleAgentEvent` 1142–1144先 emit extensions/public listeners，1147–1165才 append message。`message_end` 是完成訊息內容，不能當 disk commit ack；`agent_settled` 是 live event，未找到內建持久 run completion receipt。SessionManager1160–1188第一個user/assistant才開始落盤，以同步write/append寫JSONL，該路徑沒有 fsync。不得把本機write、外部模型完成、工具receipt視為單一交易。[A3][M2]
5. **停止目前工作並清空待送工作需兩步。** SDK `clearQueue()` 回 `{steering:string[],followUp:string[]}` 並清兩隊列（2461–2473），再 `await abort()`（2498–2507）。RPC 先 `clear_queue` 再 `abort`；官方docs明載 queue仍在時abort可繼續queued messages。abort會 abortRetry/Compaction/BranchSummary/Agent，再等待idle，不等於provider撤銷已執行結果或工具回滾；獨立bash有 `abort_bash`。[A6][D1]
6. **wait helper 名字相近、語義不同。** SDK `session.waitForIdle()` 若已idle立即完成（2510–2514）；`RpcClient.waitForIdle()` 471–485只等下一個agent_settled，不查snapshot，若事件已過會等到timeout。`RpcClient.promptAndWait` 513–517先訂閱後prompt，但沒有分流handled disposition，handled且無run時可能timeout（原始碼推論，本輪未執行）。[H1]
7. **RPC id 只是 correlation，不是冪等鍵。** RpcClient.send576–597產生req_N、寫stdin，30秒timeout只刪pending/reject，沒有cancel或query provider outcome。回覆遺失後用相同id／相同文字重送，server仍會重新handle；UNKNOWN不得靠這個id消除。[H2][R3]

### subscription、游標與 approval

- **Live subscription**：SDK `session.subscribe(listener):()=>void` 只是listeners array（1388–1397）；RPC client `onEvent` 也是live callback。沒有持久event序號／`Last-Event-ID` replay契約。`agent_end`可能帶willRetry；`agent_settled {aborted}`、message_start/update/end、tool events屬runtime訊號，不能以 transcript entry id 對每個event精確定位。[A7]
- **確實有 durable entry cursor**：RPC `{type:"get_entries",since?:entryId}`→`{entries,leafId}`，exclusive since，找不到id則`success:false`，全entry含舊分支。官方docs691/717明言跨client restart可用。這是JSONL entries，不是token/progress/approval event log。SDK對應manager.getEntries/getLeafId，host可自己用id切片。cursor缺失不能偷偷當「空帳本／新session」，先核對session identity。[R1][D2]
- **Runtime replacement**：host應透過`runtime.setRebindSession(callback)`重新取`runtime.session`並綁listener；舊session.dispose會清listeners。RPC mode已內建rebind；其順序先bindExtensions再訂新session listener（317–355），不承諾startup lifecycle events全被client看見。直接保留舊session引用會讀錯／失去event；不應為重連畫面呼叫switchSession。[X1][R4]
- **pending dialogs 不持久**：RPC mode79–83只存`Map<requestId,{resolve,reject}>`，不是可讀request記錄；91–130產生UUID、emit`extension_ui_request`，timeout/AbortSignal刪Map並回default；confirm預設false，select/input預設undefined（137–149）。沒有list/query/replay pending API。收到`extension_ui_response`時只找當前Map；未知id被忽略（766–779），沒有一般command ack。[P1]
- **UI dialog 不等於權限服務**：approval semantics由extension／Calcifer定義。原process仍活著但UI漏掉request，也不能從get_state取回dialog內容；host需自行保留發出過的pending presentation與有效性。restart後原Promise/Map消失，不能將舊approval回覆當成目前工具的授權。若用custom session entries持久化產品資料，那是新應用協定，並非Pi既有approval API；本輪不設計或實作它。
- **RPC process transport生命週期**：`RpcClient.start()`會spawn node CLI並繼承process.env（74–98），不是attach既有host；exit/error會reject pending（107–125），stop會signal child（145–167）。stdin EOF導致shutdown（rpc-mode801–805）。因此只允許UI網路重連到仍存活的受控bridge，不能把重新RpcClient.start稱作讀回。[H3]

### 供host契約整合的最小判斷

- 正常完成：讀native finalized訊息＋原guard/tool receipts，按原契約判斷，不以settled/exit0獨立接受。
- UI重連：保留原process、session、ledger；只做get狀態／entries reconciliation；不呼叫prompt/continue/switch。
- host restart：嚴格核對既有session檔與原ledger後先只讀。缺檔、空檔、cursor mismatch、missing approval或未核實provider結果都保留明確缺口；不得利用Pi open/continueRecent的create行為或guard ENOENT空帳本來清除UNKNOWN。
- 本次guard原碼查核已確認guard的completed與SDK/native transcript非原子；本次source證據進一步支持這個邊界。模型與工具UNKNOWN仍須各自收據判定，不能用一筆assistant文字替代兩者。
- 尚未驗證：UI bridge保持／重連實作、snapshot與live event競態、host crash windows、pending dialogs跨UI重開展示、extensions初始化零外送、native restart實際行為。本輪沒有增加這些執行證據。

### 固定官方 source 索引

以下全部固定commit。已安裝source map抽出的sdk/main/session-manager/agent-session/agent-session-runtime/rpc-mode/rpc-types/rpc-client，及rpc-commands.md，均以Git blob SHA逐一對上固定官方內容；摘要不以latest補缺口。節錄僅作本次本機查核，正式來源以上方固定commit為準。

- [M1：SessionManager.open/continueRecent](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts#L1760-L1805)；[open missing/empty](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts#L1008-L1054)；[只讀projection](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts#L1404-L1522)。
- [M2：JSONL persistence](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts#L1160-L1188)。
- [S1：createAgentSession初始化](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/sdk.ts#L191-L211)；[還原messages與metadata](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/sdk.ts#L403-L478)。
- [C1：CLI resume/continue選檔](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/main.ts#L415-L448)。
- [A1：isStreaming/isIdle](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L1478-L1495)；[settled發出與deferred actions](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L1078-L1100)。
- [A2：run/preflight/postrun](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L1873-L1916)。
- [A3：event先於message持久化](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L1142-L1167)。
- [A4：prompt各分支](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L2083-L2174)；[internal preflight hook](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L311-L325)。
- [A5：preflight前可能compaction](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L1920-L1935)。
- [A6：clearQueue/abort/waitForIdle](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L2461-L2515)。
- [A7：subscribe/dispose](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L1383-L1433)。
- [R1：get_state](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L448-L463)；[get_entries/tree/messages](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L636-L674)。
- [R2：完整RPC commands/state](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L118)。
- [R3：prompt/abort/clear_queue handler](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L394-L432)。
- [R4：RPC rebind](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L313-L364)。
- [X1：runtime替換](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session-runtime.ts#L117-L223)。
- [L1：低階Agent.continue](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/agent/src/agent.ts#L379-L419)。
- [H1：RPC wait/collect/promptAndWait](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L468-L517)。
- [H2：RPC request ID/deadline/send](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L556-L604)。
- [H3：RPC client程序管理](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-client.ts#L74-L180)；[stdin EOF](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L799-L805)。
- [P1：pending dialogs記憶體Map](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L79-L149)；[response未知id處理](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L766-L779)。
- [D1：官方clear_queue/abort契約](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc-commands.md#L94-L128)。
- [D2：官方durable entry cursor](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/rpc-commands.md#L689-L717)。
