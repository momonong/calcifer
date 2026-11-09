# Calcifer 0.0.8：整合驗證與平台界線

2026-11-09，Linux x86_64，Node 22.22.2、npm 10.9.7、Bun 1.4.4。依原 lockfile 使用 `npm ci --offline --no-audit --no-fund` 安裝 421 packages；沒有更新模型或依賴版本。

- `npm test`：先跑兩框架 mock characterization／offline fixtures，再跑 Node 整合套件，最終 **358 passed、0 failed、0 skipped，exit 0**。
- PR 審查指出兩個子任務之間用完額度後無法續跑；三個新增回歸案例先確認失敗，修正後完整 routing suite **20/20**，再執行上述最終整合套件。新授權只續做剩餘任務，不重送 planner／已驗收工作；額度與工作區變動限制保留。
- `node bin/calcifer.mjs --version --json`：版本 0.0.8；help 可執行。
- 以既有 bundled Python 執行 `python3 -B test/test_document_renderer.py`：**3 tests passed，exit 0**。完整實際 Word／PDF 排版能力仍依已配置 renderer、字型及人工逐頁檢查；不把單元測試當送件完成。
- 公開變更檔案已核對相對連結、diff 格式及敏感資料；未收錄私有 sessions、原始模型紀錄、憑證或實際部署端點。

測試使用合成 worker／model transport、暫時 loopback HTTP fixture 與主機 Linux 隔離驗收；真實 provider 呼叫 **0**、GPU／硬體操作 **0**。來源的原機工作樹與模型帳本保持原狀。原先的 154 與 63 項為較小範圍歷史證據，不與本次 358 相加。

## 已知平台與安裝限制

- Native Windows 未支援目前的 Linux host checker；WSL 未驗收，不提供移除隔離的 fallback。
- 新 session 需要執行帳號下的固定 Playbook；詳細前置及後端查找方式見 [Windows 交接](handoffs/windows-thor-2026-11-09.md)。
- npm 對 transitive `@opentui/core@0.6.8` 提示 Node >=26.4 的 engine warning；本次 Node 22 CLI 與以鎖定 Bun 執行的 SDK mock tests 通過，不外推原生 OpenTUI 在 Node 22 可用。未為此自動升級 runtime。
- 公開遠端範本使用 example.com；本次未部署、啟停服務、變更 DNS/Caddy，亦未聲稱手機或 HTTPS 現場驗收。
- 原始模型執行曾產生 Thor 隔離成果，但本版本測試無法證明模型品質普遍勝出、Windows／WSL 可用或機器人會操作。

GitHub 若沒有 CI，以上為本機驗證，不宣稱遠端 CI 通過。沒有建立 tag、GitHub Release 或部署映像。
