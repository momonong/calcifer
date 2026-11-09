# Windows 接續：用 Calcifer 推進 Thor 研究與競賽企劃

日期：2026-11-09，Asia/Taipei。這是可攜接續說明，不包含帳號、憑證、私人端點、模型 conversation 或原始帳本。此文件本身不增加外部資源、馬達動作、訓練、正式報名／上傳或 Git 授權；以使用者貼入本次 Codex 的指示為準。

## 目標與現在能做的事

使用 Calcifer 完成有測試、有 patch、有證據的 Thor 開發，並把實際結果寫進初選企劃。研究題目為：**單支 SO-101，依每次操作後的視覺狀態，展開單片襯材的可見摺角並小幅對位**。研究用途尚無已確認現場需求；不要改回歷史白板擦拭。

完整目標是「影像與狀態 → 策略短動作 → 抓邊／提拉／放下 → 再觀察 → 可核對判定」。Calcifer 是開發與交付工具，不在機器人即時控制迴圈內，也不將任意 LLM 輸出當馬達命令。

已完成：Calcifer 的通用 CLI、明確模型池任務分配、持續隔離工作區、原 worker 接續、主機 unittest、UNKNOWN 對帳、patch 與文件交付；Thor 的單筆離線幾何評分與批次報告。未完成：照片輸入／標註、實機控制整合、真實示範、ACT 訓練、Thor 部署與實機成功率。既有單元測試不屬於機器人實驗。

## 1. 先定位，保留筆電既有工作

1. 確認原生 Windows／PowerShell、WSL、SSH 的實際範圍；讀適用 AGENTS.md 與固定 Playbook 指南。不要沿用 Ubuntu 的絕對路徑、使用者名稱、裝置埠或虛擬環境。
2. 先查已指定或登錄的 repo；確認 remote、HEAD、分支、Git status、其他使用者或程序。沒有 repo 才在使用者確認的位置 clone；有未提交資料就保留，不盲目 pull/reset/clean。
3. 版本來源：`https://github.com/momonong/calcifer` 的 0.0.8 與 `https://github.com/momonong/thor-vla-erasebot` 的 0.3.0。以交接回覆中的合併 SHA 固定版本；package version 不是 Git tag，本次不建立 tag。
4. Calcifer 閱讀 `docs/project-cli.md`、`docs/validation-0.0.8.md`。Thor 閱讀 `docs/liner-research-plan.md`、`docs/liner-offline-evaluation.md`、`docs/development/batch-report.md`、`docs/validation-0.3.0.md`。

## 2. 分開核對三種環境

- **Windows Codex 操作端**：負責本對話、檔案與必要的本機操作。它可讀 repo，不代表 Calcifer 所有隔離功能能在 PowerShell 原生執行。
- **Calcifer 執行端**：目前 Linux-only，Node >=22.19（本輪 22.22.2）、`/usr/bin/python3.12`、flock、timeout、unshare、bwrap 及 `/usr/bin/git`。筆電若已有 WSL2，可先查可用性與 namespace 權限，再在該 Linux 環境驗收；WSL 尚未實測。禁止為了通過測試移除隔離。沒有合適環境時說明具體缺口，先做不依賴它的資料與文件工作，不自行安裝 WSL、重啟或部署遠端服務。
- **接手臂電腦**：這是另一台電腦，不是筆電本身；需透過筆電所在網路連線。位址在使用者私人交接訊息中，不寫進公開 repo。不要假定 WSL 的網路可達性與 Windows 相同，也不預設對方是 Windows 或 Linux。

依 lockfile 安裝專案依賴；不跨 OS 複製 node_modules、.venv、CLI 登入或使用者設定。Calcifer 可以先用 `node bin/calcifer.mjs --version --json` 與 `--help` 核對；`npm ci` 並不自動完成全域 `calcifer` 命令安裝。

Thor 的單筆 CLI 可在原生 Windows Python 3.12 做局部驗收：`py -3.12 -B -m unittest discover -s tests -p test_liner_evaluation.py -v`，以及 `py -3.12 -B -m liner_evaluation --target fixtures/liner-evaluation/target.json --observation fixtures/liner-evaluation/partial.json`（此合成失敗例預期 exit 1）。若沒有 `py`，使用已確認的 Python 3.12 可執行檔。批次工具要求 POSIX fd／O_NOFOLLOW，原生 Windows 會明確拒絕；批次與全套測試須在 Linux／另行驗證的 WSL 執行，不能由單筆通過外推。歷史白板測試曾有 Windows 路徑／JSON 差異；當前版本只證明 Linux，遇到具體失敗才修正相關範圍，不全面重寫歷史模組。

新建 Calcifer session 的額外前置：目前公開 `init` 固定從 **Linux 執行帳號的原生主目錄**讀 `~/.codex/AGENTS.md`，以及 `~/.codex/agent-playbook/versions/80a550a2f2efc1c3790935b2b806b1bf0971cdbe/`。核心須含相同 guides-commit；快照須有相同 `SOURCE_COMMIT`，及 `guides/engineering.md`、`external-execution.md`、`model-selection.md`、`collaboration.md`。此 loader 目前不讀另一個 CODEX_HOME。Windows 端已讀到指南不代表 WSL 已配置；缺件時依既有裝置同步流程準備明列的非秘密指南，不複製登入或整份 .codex。

公開 `bin/calcifer.mjs` 不自動修改 PATH。Codex adapter 查 Linux `PATH` 的 `codex` 並核對版本與該執行帳號登入；agy adapter 查 Linux `~/.local/bin/agy`。範例路由的 planner 需要 agy。若只有相容 Codex，可依 CLI 文件的單模型入口執行已拆分工作；不能暗中改模型池或借用 Windows 登入。

## 3. 先讓 Calcifer 在當前裝置可控地工作

- `node bin/calcifer.mjs --list --json` 應只讀；新筆電沒有 Ubuntu 的已登錄專案是正常情況，不代表資料消失。
- 公開 Git 沒有原機私有 project.json、credentials、native conversations 或模型額度。不能把舊目錄名當成筆電已可恢復的 session，也不能複製剩餘額度替新階段授權。
- 先在支援的 Linux 執行端用固定合成案例驗收 CLI／host isolation，成功後才準備新隔離工作階段、凍結 sourceFiles、writeRules、驗收與任務說明。
- 操作循環：`--status/--result` → `--prepare` → 已取得具體授權的首次 `--start --yes --jsonl` → 主機驗收 → `--result`／patch。具體修訂用 `--revise --note-file` 後接 `--start`；UNKNOWN 先 `--recover`，不能另開 session 規避。
- 範例 routing profile 的 available 不是配額查詢。查核實際 CLI 版本、登入、模型與額度，不輸出秘密。新筆電／新階段須有供應商、必要資料與呼叫上限；偏好 Argon 規劃、依任務使用 Astra／Terra，不固定 Sol、不把所有工作丟給 Argon。未取得新階段授權前不派送外部 CLI，不購買、切帳號、自動加值或 reset。

## 4. 實驗優先順序與要開發的模組

先把下面方案與使用者的實際硬體確認，沿用可驗證的小範圍推進；不要再以增加文件檔數代替研究進展。

| 次序 | 開發內容／實驗 | 結果要回答什麼 | 目前證據 |
| --- | --- | --- | --- |
| E1 | 真實照片、固定目標、人工遮罩／摺角標註與既有評分器的資料入口；先收 12–20 個不同擺放狀態作小樣本診斷 | 固定視角能否量到對位，哪些摺角無法由俯視辨識；列標註差異及誤判 | 尚無本題真實照片；合成 fixtures 只驗算式 |
| E2 | SO-101 抓邊→短提拉→放下的機械可行性；先 10 次獨立重設 | 不需人預先提邊／扶布，是否有足夠成功機會值得收示範 | 未執行；先前規劃 8/10 為進入下一關的門檻，不是可靠度證明 |
| E3 | 真實 episode 紀錄與 LeRobot 資料契約，之後小量 ACT 診斷 | 影像／關節狀態／動作是否同步且可學習；30–50 段只是起始預算 | 未採集／未訓練；有機械證據後才核對資源並開訓練 |
| E4 | 相同起始分布，比較固定程序、視覺規則與 ACT | 學習是否改善成功率、人工接手及完成時間 | A 核心 24 案／B 挑戰 24 案規劃；沿用 Thor `docs/drafts/liner-preparation-2026-11-07/` 的交錯與重設規則，144 列仍 not_run |
| E5 | 在指定 Jetson Thor 上整合與量測 | 推論 p50/p95、記憶體、動作輸出一致性及實際任務表現 | 設備與部署待確認；4090 的數字不冒充 Thor |

E1 先定義獨立的靜態照片量測入口／契約，沿用幾何算式並凍結裁切、縮放、格網與來源 hash。現有 `not_run` 明確禁止帶 mask；不能用它硬塞照片，也不把 `execution_status=completed` 改解釋為標註完成。靜態資料不捏造 duration/cycles 或機器人 criteria_met；量測報告只呈現幾何、標註差異與未知。批次輸入的每個 JSON 最多 2 MiB，與單筆像素上限不同。單張俯視遮罩不能證明無自重疊；保留獨立視角／人工檢查及 unknown。現版 evaluator 明確拒絕 `real_robot`；未來真實試驗記錄須先定義新增契約，不把它改標 `synthetic_fixture`／`offline_annotation` 來繞過。

Calcifer 現有 sourceFiles 僅接受有上限的 UTF-8 文字（256 KiB／檔），worker 可寫 .py／.md。開發使用小型合成文字 fixtures；原始照片、標註與真實驗收留在操作端，不能把照片塞進文字 snapshot 或送未獲資料授權的模型。

E2 需現場人員確認型號、follower/leader、電源／固定、串口與方向、關節校正、工作區及可達斷電方式。接上電不等於已批准任意動作或校正。先做不發馬達命令的盤點，再提出一個具體、低速、小範圍步驟並確認後執行；不知道斷電後是否下墜時不得猜測。

先完成單材質 A、單一可見摺角與小偏位，不做揉團展開、雙臂、多片分離、跨材質泛化或完整布料模擬。B 尺寸挑戰在 A 成立後另報。

## 5. 企劃書交付內容

1. 一頁內說清楚研究問題、初始／目標狀態、單臂範圍與可量測門檻。
2. 系統架構與 Robot Learning：ACT 讀什麼、輸出什麼、何時重新觀察；模型確實參與動作，規則基準公平保留。
3. 預備實驗：原始照片／逐次紀錄、方法、樣本數、成功與失敗、誤差與限制。完成哪項就寫哪項，軟體測試另表。
4. 後續三方法比較、資料切分、資源估算、停止／替代條件與活動里程碑。
5. 團隊經驗／真實影片由使用者收集，保留待補；不宣稱沒有經驗或杜撰素材。

官方 2026-11-09 核對：初選 35／45／20 分（任務、方法、經驗），中文 A4 Word／Google Docs 轉 PDF，含封面封底最多 10 面；正式經驗影片最多 1 分鐘，必須實景，不能用概念圖／模擬代替。**截止 2026-11-10 上午 11:59，台灣時間。** 先確認收件是否仍開放；不把「先做完全部學習實驗」當成初選前置，E3–E5 未完成可列計畫。硬體窗口不足就準備如實呈現的研究稿，不能造數據；正式報名／上傳仍待使用者明確授權。[官方規則](https://2026-taiwan-robotics-conference.techorange.com/)

## 停止與交付

每個階段直接在此 Windows 對話回報：程式／patch、執行命令與結果、原始證據位置、已確認與未知、下一個真正影響決策的實驗。達標停止；來源未知先核對，失敗要改假設，不無限 review 或重跑。

原 Ubuntu 對話本次只保存交接版本，不並行操作手臂或派送同一目標。不可從交接文件推定服務部署、公開研究資料、真實模型訓練或未來 Git 操作已獲授權；必要時集中確認，其他獨立準備持續做。
