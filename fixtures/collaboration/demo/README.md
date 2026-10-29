# M2 合成協作案例

note.txt 是唯讀來源；兩個可信 host mock worker 透過受控工具，先後在不同 task snapshots 加上 first/second。plan.checkIds 保持空，最終仍必須執行 host 登錄的固定 node-data check.mjs；驗收腳本與 /input/snapshot.json 獨立唯讀掛載；解析 JSON 比對 note.txt 內容，不掛 /workspace，也不執行任何 worker 程式。

CLI 只執行這個固定 demo，沒有把 plan instruction 當作程式或任意命令。run 產物與帳本留在使用者明確指定的 state root；來源 note.txt 不變。所有 model/framework 欄位是 mock metadata，generations 為 0。

一般生成程式 runtime/unit-test 驗收仍 pending；這個 demo 不證明 coding correctness。可信 host check 作者不得對 snapshot 或其衍生字串 eval/dynamic import/exec，亦不得插入程式碼模板，模型不能定義 check。
