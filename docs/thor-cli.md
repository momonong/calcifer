> 本頁保留 Thor 驗收案例與舊入口。通用用法及 Codex／agy 選擇請讀 [project-cli.md](project-cli.md)。Thor 不是產品固定專案。

# 用 Calcifer 開發 Thor

這個終端入口保留同一份隔離工作區與模型對話，接受自然語言需求，讓模型改檔，再由 Calcifer 跑 Python 測試並匯出累積 patch。實際執行後端是 **Antigravity CLI 1.5.3 / Gemini 4 Argon Medium**；OpenCode / Pi 比較底座保留，這不是它們的真實模型驗收。

## 日常使用

已初始化的本機直接執行：

```sh
calcifer thor
```

輸入一個具體開發需求即可。可使用 `/status` 看保存狀態、`/files` 看可讀檔案、`/diff` 看累積修改、`/test` 跑測試、`/export` 匯出 patch、`/quit` 離開。下次同一指令會回到原工作區和明確保存的 conversation ID，不會選用其他專案最近一次對話。

非互動命令：

```sh
calcifer thor status
calcifer thor work "替目前的襯材資料檢查工具增加指定功能，保留既有輸出契約，補相關測試。"
calcifer thor test
calcifer thor export
```

首度在另一台相容 Linux 主機準備時，使用 Node 22.19 以上、既有已登入 agy 1.5.3、Python 3.12、bwrap/unshare/timeout/flock/git。沒有隱性安裝或服務啟動：

```sh
node bin/calcifer.mjs thor init --repo /absolute/thor-repo
# 可選：--seed /absolute/previous-thor-snapshot
# seed只取已存在的 tools/liner_results.py 和 tests/test_liner_results.py。
```

`init` 不授權外部推論。核對供應商、資料及資源後，人類可在互動終端用 `/authorize 8 45`，閱讀範圍並輸入 `yes`；明確的非互動授權命令需帶用途與 `--yes`。這不是代理自行批准的新額度。每階段上限 8 次 CLI 工作呼叫、45 分鐘，從首次派送開始計時；修正呼叫包含在上限，每個需求至多兩次修正。不自動切換模型、帳號、付費方式；額外 AI credits 明確停用。CLI 工作呼叫不是供應商內部生成次數，金額與不可取得用量保持未知。

## 工作與驗證的界線

- 來源 repo 只讀。狀態預設存於 `~/.local/state/calcifer/thor`；`initial/` 是凍結來源，`workspace/` 是持續開發副本。兩者不包含 `.git`、venv、憑證、真實影像或整份研究歷史。初始化來源範圍有明確上限，新增資料須重新核對範圍。
- 可改 Python：`erasebot/`、`tools/`、`tests/`；可寫開發說明：`docs/development/`。規格、CSV模板、fixtures與主控設定保護。v1不支援刪檔、安裝依賴、任意shell、任意repo、機器人操作或訓練。
- Playbook固定commit、核心與適用完整指南、source paths與hash會保存。首輪明確傳入完整規則，後續同session接續；改規則／版本需重新核對，不靜默採latest。
- 官方 custom agent指定檔案工具，另外以官方 `PreToolUse` hook核對每次tool name與path；不把初始化清單或prompt當成OS安全沙箱。AGY自身自動載入的context、內部工具／retry仍是上游介面風險。
- 主控在唯讀、無網路的Python快照執行 `python -B -m unittest discover -s tests`；初始測試另外保存，若舊測試被修改，凍結版本仍會對候選程式執行。檔案、runtime及命令hash相同的通過證據可重用，不為安心重跑。
- 模型回覆與測試結果分開呈現。`completed`表示本次模型工作有成功終態且主控測試通過，不代表任意自然語言需求、機器人實驗或使用者驗收全部自動成立；交付仍看具體改動與目標案例。
- `/export` 以凍結原始來源為基準，包含seed及所有後續修改；先核對目前快照的驗證證據。它不套用patch、不提交、不合併、不推送；來源如果已被其他工作改動會回報 `sourceMatches=false`，套用前應檢查衝突。

## 中斷與恢復

Ctrl-C要求本機停止等待及關閉CLI程序，不宣稱遠端推論已停止。每次派送先保留intent；缺終態、串流不完整、逾時或取消會保存UNKNOWN並阻止後續派送、重設授權及匯出。

`/recover`只核對原請求的終態、原conversation/model及已關閉程序，必要時做本機驗證；不發出新模型任務。若原回條不足，維持UNKNOWN，不能以新session、新state目錄或手改帳本當成「未執行」。本版沒有供應商端取消／結算API，無證據的遠端狀態仍需人工對帳。

原始prompt、事件、usage與收據留在私有state，不加入公開Git。測試用注入worker只存在library seam，不是CLI開關。正式UI、自動多模型路由、遠端手機控制及其他供應商不在此入口範圍。

## 驗證

```sh
npm run test:thor
```

定向測試覆蓋來源／seed保留、路徑與連結、patch實際套用、互動入口、並行程序鎖、同session修正、證據重用、額度耗盡、已知未送出錯誤及UNKNOWN恢復。真實使用驗收另以本機保存的具體Thor任務和CLI回條為證；離線測試不冒充真實模型品質。

官方接入來源：[headless](https://antigravity.google/docs/cli/headless/)、[自訂agent](https://antigravity.google/docs/subagents/)、[工具hooks](https://antigravity.google/docs/hooks/)。上述版本以本機1.5.3核對，不自動升級。
