# Selfhost 離線接入準備：公開報告

更新：2026-10-26（Asia/Taipei）。**同版本離線驗證35/35通過；真實生成0次。** OpenCode 2.1.4維持主選，Pi 1.4.0對照；明確profile、服務窗口待確認、正式UI暫停。

## 證據與重跑

本公開報告整理既有測試結果，沒有新增測試。10/26已核對19項source／test／profile／fixture／lock hashes與既有35/35收據一致。環境為Linux x64、Node22.22.2、Bun1.4.4。

[衍生驗證摘要](../evidence/offline-validation-summary.json)包含版本、assertion數、各框架各案request數、source hashes及原始收據hash。原始payload／events／完整session與失敗日誌包含本機metadata，保留本地而不公開。公開摘要不是完整trace，也不是這輪重新跑測試所得。

```sh
npm ci --no-audit --no-fund
npm test
# 先前npm test已產生同版characterization收據後，重跑selfhost子集
npm run test:offline
```

安裝需要registry網路；SDK測試只走程序內mock。新raw輸出與ledger寫入本機evidence，Git已忽略；不能直接套用到真實資料留存／公開。

## 已補齊的離線能力

- 嚴格payload adapter：max_completion_tokens→max_tokens；只移除明列的OpenCode strict=false、Pi store=false／fixture marker。未知、衝突或不支援欄位拒絕；核對精確model、context、tool能力與工具歷史。
- 持久intent在傳輸前fsync；共享40次預算、每框架每task最多6、canary最多2、每次輸出最多512、總輸出預留20,480、併發1、派送窗口20分鐘。所有續寫同gate計數，未知或殘留鎖保守拒送，沒有自動清除／重送入口。
- 兩框架實際使用官方SDK／provider parser／agent loop。新T2明確read→test(red)→edit→test(green)，不是edit暗中代跑測試。
- SSE最多緩衝1MiB至finish＋DONE且無error，再交SDK；完整工具參數但缺DONE亦不執行。這改變首token與事件時序，不是原生串流延遲證據。

| 案例 | OpenCode requests | Pi requests | 可支持的判斷 |
|---|---:|---:|---|
| 工具canary | 2 | 2 | 同session工具結果回填與final；合成非零usage經parser |
| T1小修改 | 3 | 3 | 僅修改指定檔案，sentinel保留 |
| T2 bug | 5 | 5 | 五項固定邊界測試明確red→green |
| T3工具結果未知 | 2 | 2 | 一次副作用，核對收據前不再派送；乾淨session重開 |
| finish無DONE／tool無DONE／200 error | 各1 | 各1 | 不交成功文字、不執行工具；UNKNOWN持續拒送 |
| cancel | 1 | 1 | client停止；stream未drain、遠端unknown |
| length＋DONE | 2 | 1 | OpenCode續寫仍計入預算 |
| 已耗盡預算／既有UNKNOWN | 0 | 0 | 實際SDK出口在transport前拒送 |

正常task＋canary共24個合成requests、預留12,288輸出tokens。故障與預算測試使用隔離合成run，不得加總成單一live實驗。40次真實生成額度未使用。

## 失敗與修正摘要

既有迭代曾觀察到實際payload缺max_tokens、ledger併發競爭、sandbox子程序EPERM、取消收據歸錯case、headers前取消未解除等待，以及canary沒有符合單session工具往返。相應adapter、短鎖、顯式process狀態、request歸屬／取消race與canary已修正，最後35/35涵蓋。原始RED/GREEN日誌保留本地；沒有為公開版改寫舊收據或捏造新的通過紀錄。

## 仍不成立的保證

guard只提供同一已知run、單runner的保守拒送；沒有多writer平台、遠端狀態查詢、跨裝置斷電保證或遠端exactly-once。client取消只停止等待，遠端仍可能運行。子程序退出案例只測guard，未測完整原生session的unclean crash／RecoverFull。

test工具在程序內載入合成程式，不是任意模型程式碼的OS sandbox。真實生成前需確認執行隔離。SDK仍可保存完整訊息；本地guard只存hash與metadata，不代表整個系統不存prompt。

候選Qwen/Qwen3.5-4B、revision851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a、context8192與deadline均非現場證據。服務owner仍須確認恢復／實測窗口、ready/models、精確revision、能力、負載、deadline與安全憑證來源；本輪未探測或啟動服務。真實品質、效率、成本、Spark與人工接受均pending。
