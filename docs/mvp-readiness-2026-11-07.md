# 卡西法 MVP 開發準備與接續

日期：2026-11-07（Asia/Taipei）。**既有環境已核對；MVP 規格待確認；功能開發未啟動。**

本文件記錄準備階段的環境快照。使用者其後已授權提交、合併及推送這兩份文件與 README 入口；研究功能、依賴與原始紀錄不隨本次 Git 保存交付。

先讀 [MVP 範圍、驗收與順序](mvp-scope-and-acceptance-2026-11-07.md)。Thor 送件及規格確認完成後，須由使用者明確啟動下一階段；此文件不建立排程、Goal 或自動恢復機制。

## 正確工作位置與保留現場

用 `git worktree list --porcelain` 找出下列既有工作樹；不要搬移或複製專案，也不要盲目 pull、reset、clean 或重建分支。

| 工作樹 | 準備階段基線 | 用途 |
| --- | --- | --- |
| feat/research-fixture | 12c88fad019f440bc526759b6988e4017d4616e7 | P1-A 與未提交研究增量；準備核對在此完成 |
| 較早的本地 spike | 私人歷史，不列入公開交付 | 保留原狀，不作為新功能起點 |

以上是準備階段的本機觀察，不代表目前遠端 HEAD；後續 Git 交付以 PR 與 main 的實際紀錄為準。準備階段沒有執行 Git 發布操作。

研究工作樹在準備階段之前已有以下未提交內容；它們不屬本次文件提交範圍：

- README.md、package.json、package-lock.json、src/goal-sdk.mjs 已修改。
- fixtures/research/、src/research-cli.mjs、src/research-report.mjs、src/research-tools.mjs 為未追蹤新增。
- test/research-boundaries.test.mjs、test/research-workflow.test.mjs 為未追蹤新增。

本次 Git 保存只包含兩份 MVP 文件與 README 的接續入口；上述程式、fixtures、測試與依賴保留在研究工作樹。下列八項依賴、指紋與 13 項 smoke 結果屬該未提交研究快照，不能當成 main checkout 已包含研究功能的證據。

## 實際環境核對

| 項目 | 本次觀察 |
| --- | --- |
| 平台 | Linux x86_64；kernel 7.0.0-42-generic |
| Node | 22.22.2；符合 package engines >=22.19 |
| npm | 10.9.7 |
| Bun | 專案 node_modules/.bin/bun 為 1.4.4；不依賴全域 bun |
| Git | 2.43.0 |
| 隔離與命令工具 | rg、bwrap、unshare、timeout 已存在；本次工作流程 smoke 有實際執行 |
| 專案版本／lockfile | package 0.0.7；lockfileVersion 3；沒有升版或重建依賴 |

| 直接依賴 | package／lock／已安裝版本 |
| --- | --- |
| @opencode/cli、@opencode/plugin、@opencode/sdk | 2.1.4，三者逐一一致 |
| @earendil-works/pi-ai、@earendil-works/pi-coding-agent | 1.4.0，兩者逐一一致 |
| @modelcontextprotocol/client | 2.3.1，一致 |
| bun | 1.4.4，一致 |
| htmlparser2 | 8.0.2，一致 |

八項直接依賴的版本核對成立，不代表所有傳遞依賴 bytes 已作供應鏈稽核。未執行安裝、更新、全域環境變更、模型下載或帳號設定。

當前 package.json SHA-256：`2f7966dff7c74566ba63c0d18f985853527f94e141b8d600820a1b6c416370d9`。

當前 package-lock.json SHA-256：`afffe053f36f31ffa514391bbc65275c500d1466f4928d1abd177c449ec9d292`。

## 準備階段最小驗證

已在上述研究工作樹執行；main 尚未包含研究測試：

```sh
node --test --test-concurrency=1 test/p1-workflow.test.mjs test/research-workflow.test.mjs
```

結果：**13 passed / 0 failed / 0 cancelled / 0 skipped，exit 0**，約 12.8 秒。

涵蓋現成 P1 的兩框架工具工作流程、來源保留、唯讀重開／成果匯出、取消／拒絕與受保護驗收，以及研究流程的來源綁定與虛構引用拒絕。只使用暫存合成資料與短暫 loopback HTTP mock；真實模型請求 0、研究外部服務請求 0。

此結果只表示所選既有流程在本次環境可執行。沒有重跑完整 npm test，不宣稱新 MVP、完整 resume、本機推論、真實路由、手機或跨平台已通過。P1-A 歷史完整證據見 [原停止點](p1a-checkpoint-2026-10-30.md)，不改寫歷史次數。

變更前指紋與原始測試紀錄保留本機，不納入公開 Git。測試紀錄 SHA-256：`fd907719d6b2ee8b07f0f852c48c8b32144369b06e9ec6df401590f82317f013`。本文件保留必要摘要與版本；原始暫存紀錄不是公開重跑依賴。

## 既有操作入口

以下是接續時的指令參考，不代表現在要全部重跑。當新變更、版本差異或未驗證風險需要時，選擇適用的最小集合。

```sh
# 專案內的版本；不以全域 bun 取代
node --version
./node_modules/.bin/bun --version

# P1-A 工作流程與邊界
npm run test:p1

# 僅限保有未提交研究增量的工作樹；本次 main 不提供此 script
npm run test:research

# 需要完整整合驗證時才執行
npm test
```

P1-A 合成資料準備與 CLI 詳見 [p1-a-usage.md](p1-a-usage.md)。研究範例及指令目前只存在未提交研究工作樹，須核對該工作樹後使用；本次不發布研究入口。新 run 使用獨立暫存目錄，不能覆蓋既有帳本或拿新 run 解除 UNKNOWN。

## 開始下一階段前

- [ ] 使用者確認 Thor 已送件、本次 MVP 規格及要開始的階段。
- [ ] 重新核對現行工作樹、HEAD、未提交成果與是否有其他 writer；保留本次指紋與現場差異。
- [ ] 沿用固定 Agent Playbook `80a550a2f2efc1c3790935b2b806b1bf0971cdbe`，或核對使用者新指定版本；完整讀取適用指南。
- [ ] 依已確認規格再寫具體實作計畫；不從舊 2026-10-30 的長時間開發授權自動接續。
- [ ] 接入任何真實 provider／外部 CLI／Broker／本機模型前，補齊 model、account、資料、資源上限與窗口，核對現行接入契約。
- [ ] 遠端 MVP 開始前確認手機需求、裝置、通道與操作授權；目前沒有新增遠端入口。
- [ ] 任何提交、推送、合併、部署或服務變更，核對當次明確授權。

規格尚未確認與 Thor 工作進行中，是既定等待條件，不是環境故障。沒有租用雲端、恢復 P1-B、開發 UI、變更 Broker／selfhost-models 或修改 Thor。
