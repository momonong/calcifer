# 真實 Python 任務最小接入

本入口讓 Calcifer 控制資料快照、一次初始模型執行與至多一次修正、Python 驗證，以及 patch 交付。此路徑使用 **agy leaf executor**，不是 OpenCode／Pi 的 live benchmark，也不是完整 coding-agent 工作台。

## 使用

先在工作目錄讀適用規則，確認模型、帳號、資料與資源已授權。固定本輪已核對的 `agy 1.5.3` 與 `gemini-4-argon-medium`；不自動更新、登入、換帳號或切模型。CLI 啟動期間若本機版本改變，先對帳，不能當成同版本證據。

```sh
node src/live-cli.mjs run --config /absolute/authorized-task.json
node src/live-cli.mjs inspect --config /absolute/authorized-task.json
node --test --test-concurrency=1 test/live-task.test.mjs test/agy-worker.test.mjs
```

`run` 是真實呼叫入口；離線測試使用注入的本機假程序，沒有外部生成。測試 Linux 沙箱需要現有 unshare／bwrap 權限；Python 為系統 `/usr/bin/python3.12`，不安裝套件、複製 venv 或修改全域 Python。

設定是可信主控提供的任務契約，至少包含：

- `repo`：來源目錄，僅讀取 `sourceFiles` 中明列的文字檔，其他檔案不會被複製；`contextFiles` 為其中實際送模型的子集。
- `stateDir`：來源目錄之外的全新絕對路徑；保存 immutable 初始快照、每次候選、回條與 patch。已存在就拒絕再送，不能刪掉或換路徑規避 UNKNOWN。
- `writePaths`／`createPaths`：限 `tools/*.py`、`tests/*.py` 的精確檔名；本輪只新增 `tools/liner_results.py` 與 `tests/test_liner_results.py`。所有 createPaths 都是必要交付。
- `goal`、`rules`、`authorization`：本次任務、工作限制與可追溯的人類批准。文字欄位不是身份認證服務，呼叫端必須持有真正授權。
- `acceptancePath`：來源與 state 之外的主控 Python 驗收；凍結後模型不能讀寫。`commands` 只接受既有 unittest discovery 命令及10秒上限。
- `model`、`agyVersion`、`quota`、`maxAttempts`、`totalTimeoutMs`：固定模型／版本、具時間與來源的配額觀測、至多兩次 CLI turn、至多1200秒。

## 執行與交付

Calcifer 先執行 baseline，再將必要文字傳給模型。agy 在任務專用空白目錄啟動，以單次設定明確停用額外 AI credits，禁止檔案讀寫、命令、URL 與 MCP 操作；不修改使用者全域設定。模型只回傳 `{summary, files:[{path, content}]}`，由 Calcifer 驗證路徑與大小，再實體化候選快照。

每個候選使用唯讀 workspace、私有暫存目錄、無外部網路的 Linux 沙箱，執行原有 unittest 與獨立驗收。若失敗，只將具體失敗回饋至同一 conversation ID，至多修正一次；成功立即停止。驗收通過並核對來源雜湊後，產生 `thor.patch`；不直接改原 Thor、不自動 Git 提交／推送／合併。

`report.json` 分開記錄模型請求選擇、native 回報模型、session、用量、候選測試、來源保留與 patch SHA。usage 缺資料維持 null；CLI turn 次數不等於底層模型生成數，成本未知不寫零。native events 保留在私有 state，供必要對帳，不適合直接公開。

## 不確定結果與限制

- 沒有成功終態、逾時、取消、串流錯誤皆保留 UNKNOWN；局部程序退出不代表遠端推論停止。保留原 intent/session，禁止自動重試或換模型。
- 沒有通用 resume；`inspect` 僅讀結果。若主程序硬中斷，需連同 attempt 回條檢查，不能只以最後一份 report 的 preparing 狀態判斷未送出。
- 若有完整證據證明 CLI 在傳送前拒絕，主控可保存對帳回條後接續原授權；未知不能因新 state 目錄而解除。
- agy 自身內部模型重試、輔助 context、逐請求 token 上限不是此薄 adapter 能完整控制的公開介面。本輪控制工作執行數、時間、設定與輸出範圍，不宣稱 exactly-once 或已完成通用工具權限平台。
- 此成果只證明一個真實模型完成一項標準函式庫 Python 任務。正式 UI、自動多模型協作、遠端工作台、完整 Playbook loader、OpenCode／Pi 真實同模型比較仍未完成。

官方契約：[agy headless](https://antigravity.google/docs/cli/headless/)、[設定](https://antigravity.google/docs/settings?tab=cli)、[權限](https://antigravity.google/docs/permissions?tab=cli)。本機1.5.3實測 `useG1Credits` 的 JSON 值須為 boolean `false`；UI 的「off」文字不是 JSON 設定值。

## 本輪已觀測結果

2026-11-07，同一Gemini 4 Argon Medium session完成初次實作與一次具體規格修正，最終45項專案測試、11項保護驗收通過，兩個Python新增檔可由patch套用。套用後20檔逐bytes等於驗收快照，來源工作樹保留。這項結果包含主控的獨立驗收與一次程式核對，不宣稱無人監督的一般任務成功率。

原始144列模板是not_run，工具輸出六組未實測資料、成功率null；不是機器人成績。新增程式與測試由外部模型產生，主對話只實作執行器、規格與主控驗收，沒有代寫Thor解答。
