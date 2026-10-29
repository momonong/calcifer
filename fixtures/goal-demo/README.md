# 官方 SDK goal 合成案例

固定 planner 回 JSON plan，兩個相依 task 透過唯一 calcifer_tool 搜尋/read/check/edit note.txt，再讓 M2 固定 node-data check 驗收 snapshot JSON。兩官方 SDK 各走真 agent loop 與 tool-call ID 續輪，但 transport 的所有動作與回覆都是合成腳本，實際模型請求 0。

來源 note.txt 不變，產物留在指定 state root；check script 是可信 host 程式，不執行 snapshot 字串。此案例只驗確定文字內容，不能推論一般程式 runtime 正確性、模型推理能力、成本或效率。
