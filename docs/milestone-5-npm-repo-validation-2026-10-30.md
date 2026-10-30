# M5：固定零依賴 npm repo 驗證（0.0.6）

M5 新增 `node-npm-repo`：實際觀察多檔 ESM snapshot 的固定 npm test，再由同份 immutable snapshot 的 JSON CLI 輸出與 host expected 比較。只有 npm 正常 close／exit 0 **且**所有固定 oracle cases 通過才接受。npm stdout、TAP、test events、甚至 exit 0 都不是 unit-test assertions 確實執行的可信證明；受測 module 可提前 exit，獨立 oracle 仍須核對公開行為。

使用者本輪已授權離線 repo/npm/unit-test 開發與驗證，沒有因缺 live 權限停止這項工作。OpenCode 維持主選，Pi 為對照；所有 model responses 仍是 scripted mock，實際模型請求0。node-data／node-json-cli 合同及既有 UNKNOWN 邊界保留，不新增任意命令平台或自寫 agent loop。

## Caller CLI

```sh
npm run repo:check -- --repo "$PWD/fixtures/npm-repo-demo" --contract "$PWD/fixtures/npm-repo-contract.json" --state-root "$PWD/evidence/repo-check"
npm run collaboration:run -- reopen --state-root "$PWD/evidence/repo-check" --run-id <returned-run-id>
```

此 fixture 刻意把 add 寫成減法，第一條命令應回 `failed`／exit 1：npm exit1，oracle 真正輸出 -1 而 expected5。caller 可對自己修正好的、符合以下合同的 repo 使用相同命令，成功才 exit0。CLI 不編輯／套用原 repo，不安裝、不啟動模型／SDK；內部 local-check placeholder profile 只是既有 router schema metadata，`frameworkInstantiated:false`，不能當官方 SDK 執行證據。

contract 只含 `schemaVersion:1`、明列 `sourceFiles` 與 `check`；例見 [合成契約](../fixtures/npm-repo-contract.json)。check 只允許 kind、entryPath、cases、npmTimeoutMs、caseTimeoutMs、timeoutMs、maxOutputBytes；模型不能選命令或改 expected。所有 flags 必須明列且不重複，repo/contract/state-root 為 canonical absolute path，state 不得在 repo 內；contract 為有界 regular UTF-8 JSON，拒絕 symlink/hardlink，且不掛入 child。CLI 的 allowedPaths 為空，整份來源在這條 check-only 路徑皆為 protected；只跑一次獨立 host final，不加 worker check 重跑。

reopen 只採 saved authority，沒有重新讀 caller 的當前 contract。它核對 saved snapshots／runtime／definitions／journal 與語義，不執行 npm、Node child、tests 或 SDK、不恢復派送。不論有沒有 report，保留 metadata runID 與 unknown intents；只有已核對 completed 才 exit0，其他狀態 exit1，不清 UNKNOWN。

## 支援的固定 repository

最多16檔／128KiB總量，另受既有單檔16KiB等 host limits 約束。必須明列 package.json、`test/contract.test.mjs`、root basename `.mjs` CLI entry，及少量 `src/**/*.mjs` 相對 imports；可有最小零依賴 package-lock.json。沒有自動掃描／補檔／dependency install，未列 imports 不會從 live source 找回。

package 只採 name/version/private/type/scripts，須 private=true、type=module，test script 固定為：

```json
{"test":"node --test test/contract.test.mjs"}
```

可有固定 synthetic pretest/posttest canary `node hook.mjs pretest`／`node hook.mjs posttest`，但 ignore-scripts 不執行這兩個 hooks，固定 test 本身仍執行。其餘 scripts/settings、dependencies/devDependencies/workspaces package宣告、把.npmrc/node_modules列入snapshot，以及symlink/hardlink/path escape，都在worker前拒絕；未明列的live repo檔案不掛入，沒有全repo掃描。lock 僅支持無 dependency packages 的最小 lockfileVersion3 形狀，不支援一般既有 npm 專案設定。

Goal worker 只能改 host 明列的 src implementation paths。package/test/CLI entry/lock/canary與其他非寫入檔的初始 hashes 形成 protected authority，並須對上同一份 initial manifest 才派送；模型不能藉編輯驗收 wrapper、package script 或 expected 取得通過。fixed unit-test literals 自然可被受測程式看見，不聲稱它們是隱藏測試。

## 固定 npm 與程序合同

Node22.22.2、既有 npm10.9.7；以 Node bytes、npm 整棵實際 runtime tree（1964 regular files，約10.9MB）、固定 `/usr/bin/sh` 的 resolved binary hash 綁定 identity。不是只 hash npm-cli.js。runtime config 檔不讀內容，以 masked-config record 取代，掛載時以空 regular file 遮蔽；公開摘要不保存 runtime inventory 或本機路徑。

host 直接啟動可信 Node＋npm-cli.js，固定 test/offline/ignore-scripts/cache/userconfig/globalconfig/script-shell/no-audit/no-fund/update-notifier=false/workspaces=false/logs-max=0。npm **內部仍使用固定 shell**，沒有 shell-free 主張。清空繼承環境，明定 PATH/HOME/TMPDIR/LANG、隔離空 HOME/cache/tmp；user/global config 為不同 namespace 路徑的空檔。不繼承 NODE_OPTIONS、憑證、proxy 或 npm config。offline 是設定，網路邊界仍靠既有 namespace，沒有無隔離 fallback。

npm command 與每個 oracle case 各建新隔離程序。只掛明列 repo 的 immutable RO snapshot及既有可信 runtime mounts；不掛 live source、contract/host expected、其他 workspace 或 ledger。npm 與 oracle 用同一 manifest，oracle entry 真正跨檔 import implementation；oracle 不共享 npm writable tmp/cache。預設 npm≤2000ms、每case≤1000ms、whole check≤7000ms、全部command/cases合計 stdout+stderr retained≤8192bytes，host只可縮小。JSON域／UTF-8／單一值／safe integer／負零拒絕／depth8/nodes1024等沿 M4，沒有新parser。

npm 正常非零且完整 close 後仍可跑 oracle以區分語義基線；timeout、cancel、output limit、隔離失敗或未知結算不進 oracle。真正 process＋pipe close 才算結算；無法確認就 UNKNOWN，不進下一case或重送。即使 oracle全通過，npm非零仍不接受；即使npm0，空／錯誤／未完整oracle亦不接受。

每個 check、npm／oracle step 均在執行前持久 intent，完成後保存 host observation/hash。綁 full manifest、protected hashes、cases/input/expected、runtime/npm tree/shell、固定 argv/config、protocol及adapter source hash。readonly reopen 重算 raw output、完整case coverage及journal step linkage；缺step completion保留UNKNOWN，不只相信aggregate passed。runtime/protocol有變就fail closed；不重新跑程式來補證據。

## SDK 範例與證據

```sh
npm run goal:run -- demo --example npm-repo --state-root "$PWD/evidence/npm-opencode"
npm run goal:run -- demo --example npm-repo --framework pi --state-root "$PWD/evidence/npm-pi"
node --test test/npm-repo-check.test.mjs test/npm-repo-cli.test.mjs test/npm-repo-goal.test.mjs
```

兩官方 SDK 真正執行既有 loop，transport 全為程序內 mock。相同model/task/scope/cases，各planner1＋worker4=5 requests、reserved2560，工具check→read→edit→terminal，之後獨立host final；不重複同內容模型check。基線npm exit1且oracle -1≠5，修改src/add.mjs後npm0與固定輸出5／3／-6通過；protected files和原source不變。兩者接受同artifact／manifest。這不是框架品質／速度／成本排名，usage/cost仍unknown。

M5唯一完整 `npm test`：**132/132，實際exit0，fail/skip/cancel0**。新增11項含真baseline/fix、fake npm0但錯／空CLI拒絕、package/config/dependency/path/protected拒絕、npm timeout/flood/cancel無後續oracle、runtime身份、rehashed/missing evidence、caller CLI一次final、無report時readonly runID/UNKNOWN、兩SDK及Node launcher。定向受影響adapter3/3、caller CLI1/1、SDK/launcher3/3、reopen2/2均有獨立exit0收據；中途失敗保留原log。

失敗史：unsupported kind及CLI各一次預期RED；產品初版用device file作empty config，受測test child讀取EACCES，改成空regular file後通過；測試helper一度共用array使負向case污染後續case，改成clone並只跑相關cases。舊probe的user/global config同路徑前置失敗也保留，沒有重跑probe；可行性證據不冒充產品驗收。M4 121/121與更早計數仍屬原scope。[機讀摘要](npm-repo-validation-summary-2026-10-30.json)僅含白名單資料，raw wire/帳本只留本機。

## 尚未支援

這是固定零外部依賴、多檔ESM、固定npm test的執行診斷＋獨立CLI cases語義回歸。不能稱任意repository/framework、隱藏test、assertion provenance、所有輸入正確、使用者repo已修好或真模型自主修復。install、第三方dependency tree、任意scripts/workspaces/TS/build/test framework適配未實作；這些是能力範圍，非本次repo/npm缺授權。

CPU/RAM/PID配額、seccomp與production hostile-repo安全未證明；`/usr`等既有可信runtime可讀。完整native session恢復、遠端UNKNOWN結算、跨任意state-root的全主機去重亦不在本合同。live/服務/訓練仍缺另外授權，原40次smoke與mock25cap不挪用。
