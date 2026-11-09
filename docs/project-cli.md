# 使用卡西法開發專案

卡西法把目標拆成任務，依任務選擇已授權的模型，管理隔離工作區、驗證、恢復與 patch 交付。**專案、模型與執行管道分開設定**：Thor 是驗收案例；Codex／agy 是執行管道；不把產品固定在 Thor、Sol 或單一供應商。

目前支援 Linux、Node 22、Python 3.12 標準函式庫與 unittest。這條入口使用公開 CLI；OpenCode／Pi 底座研究仍保留。正式 UI、自動多帳號／quota broker 接入及其他語言驗證器仍未交付；遠端控制層的本機驗收與部署限制另見 [遠端工作台](remote-workbench.md)。

目前新建 Codex 設定固定為已核對的 `0.167.0-alpha.3.2`；舊 `0.166.0-alpha.6` 設定仍可讀回，既有 session 不自動改版本。執行前仍逐次核對設定與二進位版本；不一致就停止派送，不採用 latest 或靜默遷移。

## 單次指令與機器回饋

現在每個命令都可寫成 `calcifer --命令`。例如 `calcifer status --project demo` 與 `calcifer --status --project demo` 相同。既有互動入口保留；要由另一個 agent 或腳本操作時，使用以下介面。

```sh
calcifer --list --json
calcifer --status --project demo --json
calcifer --files --project demo --json
calcifer --result --project demo --json
calcifer --version --json
```

這些查詢不派送模型、不新增授權、不重跑測試、不重新輸出交付檔案。`--result` 讀回現有 patch／Word／PDF 與收據，核對檔案 hash、目前工作區及目標；歷史 patch 可以完整但已不對應目前成果。缺檔、路徑問題或壞掉的收據有明確診斷。未經其他證據，人工接受與是否已整合顯示 `unknown`。

| 工作 | 指令 |
| --- | --- |
| 開始已準備且已授權的目標 | `calcifer --start --project demo --jsonl` |
| 明確交付新需求 | `calcifer --work --project demo --task-file /絕對路徑/task.md --jsonl` |
| 接續已知失敗的任務 | `calcifer --resume --project demo --jsonl` |
| 提出已完成成果的具體修訂 | `calcifer --revise --project demo --note-file /絕對路徑/review.md --json` |
| 核對結果未知的原請求 | `calcifer --recover --project demo --json` |
| 執行適用驗證／沿用同快照證據 | `calcifer --test --project demo --json` |
| 查看變更／輸出已驗證 patch | `calcifer --diff --project demo --json`／`calcifer --export --project demo --json` |
| 重做已完成目標的交付 | `calcifer --deliver --project demo --json` |

`work` 也接受引號內的需求文字。需求檔案上限 50,000 bytes、須為 UTF-8 一般檔案與絕對路徑；不跟隨 symlink。需求文字和 `--task-file` 不可同時使用。新需求仍須符合本階段供應商、資料、可寫範圍與資源授權，剩餘次數本身不代表新目標已獲批准。

`--start` 遇到同一個已完成目標只會重新交付，不會自動擴張下一個目標。使用者可以先用 `--result` 取回現有成果，避免無理由重做文件轉換。`recover` 只核對原請求；仍是 `unknown` 時保留狀態，不得直接重送 `work`／`start`。

完成後若找到具體內容／驗收缺口，先用 `--revise --note-file /review.md`（或 `--note "具體修訂"`）記錄。修訂檔限 UTF-8 一般檔案、絕對路徑、最多 32,000 bytes，說明最多 8,000 個 JavaScript 字串單位；不跟隨 symlink。這一步不呼叫模型、不重設預算，會保留舊完成收據，將原目標標成待修訂。之後 `--start` 接續原 worker conversation 並再次交付；`--resume` 只接續工作。UNKNOWN、用量不足、工作區已漂移或不符合原 prepared 目標時拒絕，不另開 planner 或換模型繞過。修訂仍必須在既有資料及目標授權內。

### JSON 契約

- `--json`：stdout 恰有一個 JSON 結果；人類進度診斷在 stderr。
- `--jsonl`：stdout 每行為一個 JSON 事件，結尾恰有一個 `type: "result"`。事件含 route、dispatch、checks、允許的工具種類、heartbeat、cancel_requested 及文字訊息；不轉送原生工具的完整 payload 或原始任務內容。
- 所有結果使用 `schemaVersion: 1`，包含 `command`、`project`、`stateDir`、`ok`、`exitCode`、`data`、`error`、`nextActions`。`error.code` 可用於分辨 `AUTHORIZATION_REQUIRED`、`RESOURCE_LIMIT`、`PROJECT_PENDING`、`PROJECT_BUSY` 等原因。
- 退出碼 `0` 表示這個指令完成；`1` 表示操作失敗；`2` 表示參數錯誤或缺少明確確認。**status／result／recover 查詢成功不代表目標完成**；須讀 `data.status`、`data.goal.status`、`data.pending`、`data.checksCurrent` 及交付物的 `verified/current`。
- `checksCurrent` 表示已保存的通過證據對應目前檔案快照，不表示剛剛重新跑過、人工接受或領域實機驗收通過。`result` 不追溯其他對話中的語意／排版審閱，僅呈現保存的收據。
- 機器模式即使連到 TTY 也不開互動提示。需要新授權時回 `CONFIRMATION_REQUIRED`；`--yes` 只傳達已取得的人類批准，不能拿它創造批准或擴張資料範圍。
- 保持現有前景執行方式。JSONL 方便操作端持續接收進度，但不是新增背景服務、手機介面或斷線後自動運行保證；中斷後先讀狀態及原收據。

目前 Thor 的既有成果可用 `--project thor-batch-20261109` 與 `--project thor-proposal-20261109` 查詢；名稱只是本機案例，指令本身沒有綁定 Thor。

### 不寫私有 JS 也能準備任務

先依下一節 `init` 建立有 routing 的新隔離工作階段，再準備固定任務：

```sh
calcifer --prepare --project demo \
  --task-file /絕對路徑/task.md --title "具體可驗收的目標" \
  --turns 8 --note "本階段允許的供應商、資料、操作及資源" --json
```

`prepare` 不呼叫模型、不授權、不重設用量，只適用尚未授權／使用且已配置 routing 的新階段，程式與文件目標皆同。預設交付 patch；現有文件流程可另提供 `--documents /絕對路徑/documents.json`，沿用既有 `source/python/renderer/maxPages/maxBytes` 契約（A4 PDF 最多 10 頁、20 MiB）。沒有 routing 的文件任務在準備／重開時會報 `PREPARED_DOCUMENTS_REQUIRES_ROUTING`，不等模型工作後才失敗；一般單模型 `work` 入口不受影響。轉換器設定限操作者信任的本機工具，不接受模型產生的任意執行器。

完成供應商與資料範圍確認後，人工或已有明確批准的操作者使用 `calcifer --start --project demo --yes --jsonl`。這會沿用準備好的確切呼叫上限及範圍。後續查詢不需要 `--yes`，既有批准仍有效時接續也不重設預算。

離線驗收：`npm run test:commands`；完整受影響專案流程：`npm run test:project`。包含機器輸出、未知結果與取消保護、交付物完整性、工作區漂移及合成 worker 跑完整主機驗收到 patch 的流程；不呼叫真實模型。

## 直接開啟

在已安裝啟動器的 Ubuntu 主機終端輸入：

```sh
calcifer
```

選單列出既有專案、狀態、模型與已使用呼叫次數；輸入編號後進入該專案對話。直接輸入需求，`/status` 查完整狀態，`/diff` 查看修改，`/export` 匯出 patch，`/quit` 離開。開啟、選擇與離開不呼叫模型、不新增授權或重設預算；實際工作仍受原階段、各模型上限及 UNKNOWN 保護。初始畫面不重印完整舊回覆，`/status` 才顯示。

一般 `init` 建立的專案會自動登錄。既有工作階段若用自訂 `--state` 路徑，只需登錄一次：

```sh
calcifer register --project my-project --state /絕對路徑/既有工作階段
calcifer --project my-project
```

登錄只保存名稱、原路徑與工作階段 ID，位於 `~/.local/state/calcifer/.registry/`；不複製工作區、不讀取登入憑證。預設目錄下的既有專案也會列出，不掃描其他磁碟目錄。同名衝突、原路徑失效或身分改變會明示錯誤，不偷偷改用其他工作階段。沒有已建立的專案時會顯示 `init` 指引，不自動建立或呼叫模型。

管線等非互動環境只列出清單，不等待輸入或自動選取。`calcifer --help` 仍顯示完整命令。這是本機終端入口；手機與遠端入口的可用性另依部署狀態確認。

## 建立依任務選模的專案

在 Calcifer checkout 下執行；`init` 不呼叫模型。執行端需 Linux、`/usr/bin/python3.12`、flock／timeout／unshare／bwrap 及 `/usr/bin/git`。公開 init 的 Playbook loader 固定查執行帳號 `~/.codex/AGENTS.md` 的 guides-commit，以及 `~/.codex/agent-playbook/versions/80a550a2f2efc1c3790935b2b806b1bf0971cdbe/` 的 `SOURCE_COMMIT` 和 `guides/{engineering,external-execution,model-selection,collaboration}.md`；目前不自動解析其他 CODEX_HOME。核心、快照 commit 與四檔都須存在且一致。WSL 是另一個環境，不能假定 Windows 的規則與登入已在其中可用。缺少時依裝置同步流程補明列的指南，避免重複 init。

```sh
calcifer init --project taskboard-routed \
  --repo "$PWD/fixtures/projects/taskboard-cli" \
  --profile "$PWD/profiles/taskboard-python.json" \
  --routing "$PWD/profiles/routing-quality-first.json"
calcifer status --project taskboard-routed
```

沒有安裝啟動器時，使用 `node bin/calcifer.mjs` 取代 `calcifer`。公開 bin 不調整 PATH：Codex adapter 從 Linux 執行端 PATH 找 `codex`，agy adapter 固定讀該帳號 `~/.local/bin/agy`，兩者各自核對版本與登入。原開發機私人 wrapper 的 PATH 設定不包含於 Git。範例 routing 的 planner 需要 agy；只有相容 Codex 時可用下方單模型入口執行已拆分工作，仍須相應授權。

專案設定列出名稱、允許讀取的 `sourceFiles`、可寫子目錄／副檔名 `writeRules`，以及 `check.testDir`、`check.timeoutMs`。目前可寫 `.py`／`.md`，驗證器是 `python-unittest`。Taskboard 的測試目錄是 `checks`；不是寫死 Thor 或 `tests`。

路由設定與專案設定分開，初始範例為：

| 工作 | 初始候選 | 原因與限制 |
| --- | --- | --- |
| 規劃、拆分任務 | Gemini 4 Argon High／agy | 採使用者目前經驗作起點；每階段最多一次規劃，不反覆叫高成本模型 |
| 困難分析、非平凡實作 | GPT-6 Astra High／Codex | 優先品質；可使用明確授權的既有 credits |
| 邊界明確的例行工作 | GPT-6.1 Terra Medium／Codex | 先列為可驗證候選，並非已證明較佳；可在設定停用 |
| 機械操作、測試、匯出 | 主機程式 | 不另派一個模型來重複跑檢查 |

這是可修改的偏好，不是 benchmark 排名或永久角色。Sol 仍可顯式使用，但不在初始路由裡。`profiles` 列出 model、effort、版本、能力、每階段呼叫上限、資源來源與期限；`preferences` 為各任務類型列候選順序。Planner 可提出不同配置中的合適候選，host 再檢查授權、能力、可用性、資料政策與預算。

`available`、`resource`、`expiresAt` 是操作者核對過的資源快照，**不是即時 quota 查詢**。範例設定不證明登入或餘額，也不授權花費；實際派送前核對當前帳號。`local-only` 在尚未接入本機執行器時直接拒絕派送，不把私密資料轉交雲端。

## 授權、執行與完成

下面的命令會顯示模型、管道、現有資源及上限，再要求終端確認；文件本身不授權執行。

```sh
calcifer authorize --project taskboard-routed --turns 3 \
  --note "只開發此合成專案，使用已確認的模型和現有資源"
calcifer work "新增 count_blocked，保留 count_open 並加入相關測試" \
  --project taskboard-routed
calcifer export --project taskboard-routed
```

預設不設整個目標或單次模型工作的執行期限；只要仍在授權範圍內，就持續推進到完成條件滿足。省略 `--minutes` 即使用此模式，狀態顯示「不設執行期限」。需要有期限的實測時，明確加上 `--minutes 15`；該期限從首次派送起算。既有授權保留原本的期限，不因程式升級而自動放寬。

規劃、工作及修正仍共用明確授權的呼叫次數，每階段目前最多 32 次 CLI 工作呼叫；2 次適合一次規劃加一次實作。取消時間限制不會自動增加額度、兌換資源或開啟新的工作階段。這不是原始 API 生成次數或硬性金額上限；模型內部推理、工具往返與 native transport retry 都可能產生多次請求。

測試程序、CLI 版本／登入檢查與取消後的本機程序收尾仍有各自的逾時保護。這些逾時不會因模型正常工作超過 15 或 20 分鐘而中止整個目標。Ctrl-C 仍可停止等待；遠端結果未知時仍需核對原請求。CLI／供應商自身的連線與服務限制不由卡西法消除。

模型先產生結構化任務與驗收條件，host 檢查範圍、依賴與候選後依序執行。每個任務用自己的 native conversation；同一任務修正沿用原 conversation。下個任務取得前面驗證過的檔案與摘要。這版採**依序整合**，尚非多個 worker 同時改檔與自動解衝突。

模型不能降低原目標、授權或 host 驗收。主機執行 unittest 與必要凍結回歸；同版本、同快照的充分證據可重用。完成狀態表示配置的 host checks 通過；專案的額外領域驗收仍須提供對應測試或核對，不能只憑模型說完成。

## 接續、恢復與停止

```sh
calcifer --project taskboard-routed
```

互動中直接輸入目標；也可使用下列命令。

| 命令 | 行為 |
| --- | --- |
| `/status`、`/files`、`/diff` | 查看模型分配、理由、用量與修改 |
| `/test`、`/export` | 執行必要驗證與輸出標準 patch；不自動套用或提交 |
| `/recover` | 核對原始請求收據，不重送模型 |
| `/resume` | 在現有有效預算內接續已知失敗的工作，帶回具體測試錯誤；不重新規劃 |
| `/authorize N [M]` | 先明確批准新的資源階段；省略 M 不設時間期限。預算耗盡後，原 goal 可沿同一失敗 session 接續 |
| `/abandon 原因` | 明確放棄未完成 goal，保存原紀錄及修改；不重設預算，不清除 UNKNOWN |
| `/quit` | 離開；之後用同一專案名稱接續 |

UNKNOWN 會擋住工作、重授權、放棄與成功交付，不能藉換模型或新工作區繞過。Ctrl-C 分別保留停止等待、本機程序／串流與遠端未知狀態。已完成結果如果檔案漂移，就不能沿用舊成功證據。

## 單一模型模式與既有專案

```sh
calcifer init --project taskboard-astra \
  --repo "$PWD/fixtures/projects/taskboard-cli" \
  --profile "$PWD/profiles/taskboard-python.json" \
  --backend codex --model gpt-6-astra --effort high
```

單一模型模式不付出規劃呼叫，適合已拆好的工作。既有 Sol／Medium 與舊 Thor／agy 工作階段保留原設定，不靜默改模型。`calcifer thor` 仍等於 `calcifer --project thor`。

工作區預設位於 `~/.local/state/calcifer/<名稱>/workspace`，必須在原 repo 外。來源、規則、控制檔與舊測試會保存並核對。任意深度 `AGENTS.md` 不作一般可寫資料；Codex 既有 immutable inputs 逐檔套用唯讀保護，新建不允許的檔案再由 host diff 拒絕交付。原始 repo、Git、服務與硬體不因工作階段而獲得操作授權。

## 驗證與證據限制

```sh
npm run test:project
```

這是離線 fixtures、原生協定測試及隔離 Python 測試，不呼叫模型。真實專案驗收另保留每輪任務、分配理由、model／effort 請求、native session、用量、測試、patch 與停止原因。

目前新設定鎖定 agy 1.5.3、Codex 0.167.0-alpha.3.2；既有舊設定保留其固定版本。CLI argv 證明請求了哪個 model／effort；Codex JSONL 未提供實際 model／effort 認證，不能冒充。帳號總額度變動不等於單一任務成本。agy 關閉額外 credits fallback；Codex 使用既有登入及明確授權的現有資源，不傳入 API key、不購買、不兌換 reset。

官方介面：[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)、[permission profiles](https://learn.chatgpt.com/docs/permissions)。CLI 升級須核對契約及受影響驗證，不默默改用 latest。


## 準備好的文件工作階段

主機可先用 `prepareProjectTask` 建立與 project ID、profile 及 routing hash 綁定的單一任務。這不授權模型。已準備的專案在開啟時顯示 `/start`；使用者確認完整模型池、呼叫上限與資料範圍後，才啟動既有 authorize/work 流程。接續時不重設額度，UNKNOWN 須先 recover。

`/start` 完成固定目標後，主機自動匯出 patch，從驗收通過的檔案快照產生 DOCX／A4 PDF，附 evidence.md、gaps.md 與收據。`/deliver` 只重做文件交付，不呼叫模型。超過 10 頁或 20 MB 時保留診斷並報錯，不假報完成。完成的模型目標若要再修改內容，須另定修正範圍，不能以 `/start` 偷加模型工作。

文件工具使用獨立的 bundled Python、python-docx 與 LibreOffice renderer，路徑存在私人 prepared-task.json，不含於公開範例。Markdown 支援段落、標題、清單、短表格、https 來源與明確分頁；不讀取外部圖片、不執行 HTML。轉換有本機逾時及取消收尾；不限制模型工作的總時長。

交付目錄位於原 state 的 `deliveries/`，成功位置記於 `latest-delivery.json`。Word 可編輯，PDF 為草稿；自動頁數檢查不取代語意、逐頁排版、隊伍和影片資料的人類審閱，也不代表已送件。這仍是前景 CLI，需維持終端與主機運作，不保證登出、關機後繼續。

驗證：`npm run test:project`；以有 python-docx 的 bundled Python 執行 `python3 test/test_document_renderer.py`。這些測試不呼叫真實模型。原始 CLI 呼叫上限並非 token、模型內部請求數或金額上限。

### 準備工作階段的來源與完成回報

2026-11-09 真實企劃實測發現，僅提供檔名而任務又禁止 shell 時，Codex 可以寫稿卻無法讀到規格；三項結構檢查仍會通過。因此 prepared 任務現在由主機提供有大小上限的完整授權檔案快照與 hash，planner 與 worker 都可直接讀取；每個工作任務保存 input-context.json，同 native conversation 的內部修正不重送全文。不增加 shell、網路或資料授權，超出上限就明確拒絕，不靜默截斷。

prepared worker 必須明確回報 complete／incomplete、輸入 hash 及已核對來源；incomplete 立即保留成果停止，不再以缺檔測試強迫它編成通用稿。這份聲明只證明模型回報，不等於人工語意驗收。文件交付需有這組紀錄；舊稿缺來源確認時會拒絕再宣稱交付成功。領域規格、來源支持程度及實機證據仍須各自核對。

若已完成的稿件在驗收中發現具體問題，主控可用 `revisePreparedProject({stateDir,note})` 對原 prepared goal 開立修正：先完整保存先前 goal／lastTask 收據，保留檔案、原模型、原 conversation、所有已用次數與上限，再由 `/start` 接續最後一個已分配 worker。它不重跑規劃、不補額度，也不允許未知結果、檔案漂移、額度耗盡或更換資料範圍。這個入口是已授權範圍內的具體修正，不是推翻原收據或假裝先前驗收正確。

### 從本對話操作準備好的程式任務

`prepareProjectTask` 支援明確的 `documents: null`，供一般程式目標使用；這種模式必須有任務路由。它沿用相同的來源全文、固定 Playbook、完成回報、主機測試與 UNKNOWN 保護。`start` 完成後直接交付經驗證的 patch，`deliver` 重新匯出時不呼叫模型，不要求 Thor 或 Word/PDF 設定。文件目標仍使用既有 documents 物件，舊工作階段不遷移。

原目標對話可依已確認資源操作相同 CLI／公開主控介面，跟進程序、讀取失敗收據並接續原 worker；這不需要新常駐服務或另開聊天。新的資料／寫入範圍仍須匹配階段授權，前一階段剩餘次數不能挪用。主機檢查通過只證明指定驗收，交付 patch 不等於套用、合併、實機成功或使用者接受。
