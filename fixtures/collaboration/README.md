# 離線路由合成案例

`plan.json` 是已明列任務的合成計畫；不含模型 planner 輸出。`mock-registry.json` 是 host 提供的合成 registry，`kind` 固定為 `mock`。兩個 model 名稱沒有對應真實端點或已連線模型；framework 只用於 metadata。

- analysis 需要 analysis 能力，指派 mock-analysis。
- edit 依賴 analysis，需要 edit 能力，指派 mock-edit。
- verify 依賴 edit，需要 verify 能力，指派 mock-analysis。

白名單中的 `src/example.mjs` 與 `fixture-check` 只示範授權宣告，不會建立檔案或執行命令。CLI 不排程或執行相依任務，也不讀取任務宣告的 writePaths。host 必須把 registry 與不可信 plan 分開提供，不能由 plan 擴張授權。

```sh
npm run collaboration:plan -- --plan fixtures/collaboration/plan.json --registry fixtures/collaboration/mock-registry.json
```

有效輸出為 JSON，包含三個 assignments 與明確 mock provenance；任一必要任務無合格 profile 時，整份計畫拒派、assignments 為空，程序 exit 1。修改 registry 不會啟用 live mode 或付費 fallback。
