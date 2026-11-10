# WSL 本機離線驗證 — 2026-11-09

這是 Windows 筆電既有 Ubuntu WSL2 的本機驗證，基準為 Calcifer 0.0.8 `65faef02e9c5bfa210e35c73d63b4f2abf003be9`。以下修正尚未提交、合併或發布，也不代表原版 0.0.8 已通過 WSL 驗收。

## 環境與修正

- Ubuntu 24.04.3 LTS、Node 22.22.2、Python 3.12.3、bubblewrap 0.9.0、lockfile 中的 Bun 1.4.4；保留既有隔離。沒有移植成原生 Windows。
- 官方 Node 使用者目錄安裝，另補 `/usr/bin/node` 指向該二進位，滿足原有 fixture 的固定 shebang；原路徑不存在，未覆蓋其他版本。
- 原 loader 固定要求 `80a550...`，但取得的原始核心明載 `a937f9...`。改讀核心唯一的完整 pin，仍核對 snapshot 的 `SOURCE_COMMIT`、必要指南與安全檔案讀取。未修改核心來迎合程式，也未放寬缺檔／symlink 保護。
- 原取消測試以 model admission intent 當成 HTTP 已送出的證據。新增本地 mock 實際收件的可追溯紀錄，再於收到請求後取消；仍要求 UNKNOWN、恰一次 HTTP、沒有工具派送及 mock 關閉。收件紀錄不表示真實模型推理成功。

## 實際驗證

| 範圍 | 結果 |
| --- | --- |
| 原始基準完整 npm test | 360 項：328 通過、32 失敗 |
| 補 Node 路徑後，受影響 adapter／流程測試 | 54／54 通過 |
| 新 Playbook 回歸，修正前 | 6 項：3 通過、3 失敗 |
| 新 Playbook 回歸，修正後 | 6／6 通過 |
| 取消測試以實際收件為前提，觀測點修正前 | 1 項失敗，缺少實際收件證據 |
| 取消測試，觀測點修正後 | 1／1 通過 |
| 全部程式修正後 npm test | 366／366 通過，0 skip、0 fail，約 131 秒 |
| 真實已安裝 Playbook loadProjectContext | 成功，pin a937f9199475f7affdab7545d81b6222f2ae0e5f |
| Thor E1 公開 CLI init／prepare | 成功，隔離 workspace 已建，未授權、模型呼叫 0 |

證據保存於本機 `~/.cache/calcifer-bootstrap-20261109/`，含各次 red／green、完整測試日誌與非秘密環境收據。離線測試使用 synthetic fixtures／本地 mock，不呼叫真實模型。這些前置修復由操作端 Codex 完成，不能算成 Calcifer 自主完成 Thor。

## 限制

- Google agy 與 Codex 的 Linux 登入、模型目錄已核對；metadata 查詢不等於模型任務成功。Google CLI 沒有可用的精確剩餘額度查詢。
- 安裝的是明列的非秘密核心與指南子集，並非宣稱完整 Playbook installer／所有客戶端 discovery 驗收。
- 真實模型派送、Thor E1 領域驗收、照片量測與機器人實驗仍各自待驗。不得由 366 個離線測試推論這些能力。
- PR #12 的初始 routed maxTurns=1 授權問題仍未修復。派送前 worker 失敗的恢復問題已在後續本地修正（見下節），尚未提交或更新遠端審查狀態。

## 實際 E1 接入後的追加修正

Argon 實際規劃成功後，Astra 在派送前發生 `CODEX_PREFLIGHT_FAILED`。唯讀重現顯示 bwrap 看不到 Windows 掛載目錄內的 Codex ELF。改將同一份二進位安裝至 `/usr/local/bin/codex`，雜湊一致，並保持原本 sandbox profile；未擴張可讀或可寫主機路徑。

原生隔離正負向驗證確認：允許目錄寫入能保存，固定輸入與 AGENTS 控制檔維持唯讀，外部主機 canary 不能讀取或持久修改。沙箱內可以有私人 shadow scratch；以主機實際檔案核對區分，沒有把沙箱內成功寫入當成主機越界。

此失敗也實際重現 PR #12 的 pre-dispatch resume 缺口。新程式保存明確未派送收據、快照與可接續 checkpoint。舊工作階段只在第一個 Codex preflight-only 失敗、沒有 native 派送產物、原 intent／已接受快照／目前檔案全數一致時恢復，並保存原失敗 task；不以單純「缺少 dispatch 檔案」推論未發送。UNKNOWN 保護、同任務對話與既有用量不變。

新增四項回歸：原版 1 通過／3 失敗，修正後 4／4 通過。完整 `npm test` 為 **370／370 通過**，0 fail、0 skip，約 139 秒。原 E1 計畫在修正後透過公開 `start` 接續，沒有重跑 planner 或重設授權。真實模型／Thor 成果與領域驗收仍見個別 E1 收據，不能由此推論完成。


## 同一授權內的呼叫改配與 prepared 綁定

2026-11-09：新增 `reallocate` 的操作端修復。本機回歸先由 7 項失敗修至通過，完整 377 項通過後，真實 prepared/start 在派送前揭露 `PREPARED_SCOPE_CHANGED`。這次沒有耗用模型呼叫；保留原失敗紀錄。

補上以可稽核收據核對凍結 routing binding 的整合後，相關 9 項測試與完整 **379／379** 回歸通過、0 失敗、0 跳過。涵蓋原會話接續、總上限保持、原 prepared 文件不改、後續新授權仍可追溯、竄改收據／模型範圍拒絕。

真實 E1 透過公開 CLI 改配 1 次，用量保持 3／4，原 budget、goal、conversation、workspace manifest 與 prepared hash 皆核對相同；之後才送出第 4 次 Astra 呼叫。Thor 的最終結果另以該次主機驗收收據為準。這些框架修正由操作端 Codex 完成，並非 Calcifer 自主成果；沒有移除隔離或重設用量。
