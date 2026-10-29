# Live 與蒸餾的後續門檻

M3 完成官方 SDK 的離線合成接線；沒有真實模型品質/成本、Spark 推論或一般生成程式 runtime correctness 證據。原始同模型 canary + T1/T2/T3、40 次 selfhost protocol 保留；M3 的 25 次是獨立 mock-only cap，不是可用 live 配額。

開始 live 前仍需服務擁有者確認恢復及窗口，並固定精確 endpoint/model/revision、serving image/量化、chat template、tool/reasoning parser、context/thinking policy 的當前證據。還需同一合成任務/工具/驗收、兩框架固定 profiles，以及涵蓋 planner/worker/所有 SDK 續輪的總 request/output/deadline/concurrency 方案。憑證沿既有秘密管理方式取得；不寫入程式、聊天或公開報告。沒有付費或未核准模型 fallback。

完整 wire、工具與 request ledgers 私下保留，公開僅白名單合成摘要、失敗/未知/人類介入與明列 usage；缺資料就 unknown。Spark 預期只供推論，agent/檔案/Git/驗證仍在開發機；這是待確認配置，本輪沒有操作 Spark、GPU、服務或模型下載。

蒸餾尚未開始。使用者允許必要探索，不等於已指定 teacher API/model、資料用途條款、student checkpoint/授權、GPU 或生成/訓練額度；原 selfhost smoke 也不涵蓋教師生成。先有可重現評估與 held-out 任務，才能分辨模型、工具或流程問題。

後續如另行核准，可只保存授權資料的可觀察輸入、工具動作/結果、patch 與驗收，明列來源/許可/失敗並分開 train/held-out。不能收集隱藏思考鏈、私人 prompts 或秘密，也不能把 scripted mock 軌跡當高品質教師示範。必須先定義 teacher/student/資源與用途，再依未見任務的正確性及失敗行為評估；不承諾能複製 Codex 能力或得到品質保證。

本輪未呼叫教師模型、上傳訓練資料、建立訓練 job 或下載權重。一般 runtime 驗收是尚未實作/驗證的能力；live/服務窗口則是另缺必要授權，兩者不可混稱 blocked。
