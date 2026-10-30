# M6：已驗收保存成果的唯讀 patch 匯出（0.0.7）

M6 把已完成且通過整合驗收的 collaboration run 或 goal 保存成果，匯出為可檢閱的標準 unified patch。它沿用既有 authoritative reopen；不重新派送 worker、建立 SDK、執行模型、npm 或受測程式，也不套用來源。M4／M5 check protocols 保持原 bytes，沒有新依賴。

## 使用介面

```sh
node src/artifact-diff-cli.mjs --state-root /absolute/state --run-id RUN_ID > change.patch
```

只有 `--state-root` 與 `--run-id`，不得重複；state-root 必須是 absolute canonical path。不要用會印 banner 的普通 `npm run` 包裝。API 為 `exportArtifactDiff({stateRoot, runID})`，回傳 `{patch: Buffer, receipt}`。測試用 host spawn seam 不暴露為 CLI 權限。

成功 exit0，stdout 僅完整 patch bytes，stderr 一行 JSON receipt；含 acceptance scope、run format、initial／final manifest hashes、changed count、patch bytes／SHA-256 及 `noInferencePerformed:true`，不預設公開 native session／host paths。無變更輸出空 patch，changedFiles=0。拒絕 exit1、stdout 空、stderr 短 JSON code。caller 自行管理輸出檔；shell 可能在拒絕前建立或截斷 redirect 目標。

## 接受與完整性

只接受 completed、integrationAccepted=true、沒有未結算 intents 的狀態。goal 從 canonical outer run 的 inner-state 取得 inner run，核對 outer／inner report 一致。goal 沿既有 reopenGoal 規則重新核對當前來源，已變更／移走就拒絕；一般 collaboration run 的 reopenRun 依保存快照驗證，不重新讀目前 sourceDir。兩者均沿既有規則核對 runtime／protocol 及適用的 SDK evidence，不繞過身分核對。patch 始終以保存 initial 為基線；套用到已改變的外部 repo 須另行檢查。

重新以 complete snapshot 讀取保存的 initial／integration，沿既有 UTF-8／NUL／檔案與總量限制核對 initial manifest、report initial／final hashes，以 allowedPaths 重算 diffSnapshots。report.artifacts 的完整 membership、順序、精確 keys、path／beforeHash／afterHash／content 必須逐筆相同；缺漏、重複、越權、偽造內容／hash 都拒絕，不能只信 report flag。symlink、hardlink 及未列目錄項沿既有安全讀取拒絕；另拒絕大小寫無關 `.git` 路徑節點與 `.gitattributes`。

只支援相同檔案集合的 UTF-8 內容修改；沒有建立／刪除／rename／mode／symlink／binary diff。scratch regular files 固定為內容載體，不聲稱保留原 executable mode。CRLF、BOM、空檔與缺最後 newline 逐 byte 保留，path quoting／EOF 標記由成熟 Git 輸出，不自行改寫 patch header。

## 固定 backend 與副作用

僅把已核對 changed before／after bytes exclusive 寫入專用 0700 scratch 的 `a/` 與 `b/`，不 link 回來源或 state。固定 `/usr/bin/git`、argv、無 shell；no-index／no-ext-diff／no-textconv／no-renames／no-color／text／unified3／no-prefix／Myers／no-indent-heuristic／full-index，並固定 quotePath、attributesFile 與 autocrlf。

不繼承環境，僅固定 PATH／LANG、private HOME、禁 system/global config／attributes 與 repository discovery／optional locks 的必要 Git 設定。Git 是受信任 host 檔案比較工具，非受測 repo 的 executable。主機缺此固定 executable 就明確拒絕，沒有下載或 fallback；此版以 Linux 為驗證平台。

stdout 最多 1MiB、stderr 最多 8KiB、2秒 timeout；TERM 後最多200ms升 KILL，完整 process＋pipe close 才結算。無變更只接受 exit0／空輸出，有變更只接受 exit1／非空輸出；其餘 exit／signal／spawn error／timeout／overflow 拒絕，不發布半份 patch、不重試。結算無法確認時回拒絕並保留 owned scratch，避免在 child 仍可能使用時刪除；本版沒有自動回收 unknown scratch 的命令。已確認 close 才移除 owned scratch。

## 驗證與限制

三組定向涵蓋真 Git 輸出與 byte/path 邊界、無變更／CLI stdout、重新 hash 仍不完整 artifacts／狀態／權限拒絕、固定程序環境與 timeout／limits／close／cleanup。只在一次性合成 target 做 `git apply --check` 互通性檢查，沒有實際套用來源。

沿用 M5 已保存的 OpenCode／Pi goal，唯讀匯出各成功 exit0；同一初始／最終 manifest 產生相同 257-byte patch，SHA-256 `94828ab947bf9521ff5db155677b1565c3d8657bea2906b6f1a23ccac258a005`。source 與保存 state 的完整樹內容／模式／link-count hash 前後相同，沒有為產生匯出輸入重跑 SDK、npm／oracle 或模型。這是保存成果的工程交付驗證，不是新模型品質證據。

M6 唯一完整 `npm test` 為 **135/135、實際 exit0、fail／skip／cancel0**；定向 3/3 的相同 source 證據沿用，沒有額外重跑。完整套件與原始收據 hashes 見 [機讀摘要](artifact-export-validation-summary-2026-10-30.json)。full 中既有 SDK 合成測試仍依原套件執行；匯出功能本身不觸發這些工作。原始保存 runs、wire／ledger、完整 logs 與執行路徑只留本機。

patch 僅描述已驗收 snapshot 的內容差異，不能保證對後續變更的外部 repo 套用成功。外部套用、真模型自主拆解／修復、一般 frameworks／依賴、live 服務／訓練、正式 UI 與人工接受不由本增量證明。
