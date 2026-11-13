# 継続性の実証（F-3）

- **対象主張**: 「会話を捨てても進捗が残る」
- **判定区分**: **条件付き**（一時 `IDLESHIFT_HOME` 上の実サービス・実リレー自動テストでは全シナリオを再現・実証済み。実アプリ 2 種間での実機引き継ぎは未実施のため条件付き）
- **検証日**: 2026-11-12
- **検証テスト**: [tests/evidence-continuity.test.mjs](../../tests/evidence-continuity.test.mjs)
- **生データ保存先**: [docs/evidence/raw/continuity/2026-11-12/test-output.txt](raw/continuity/2026-11-12/test-output.txt)

---

## 1. コード上の根拠（確認済み）

1. **同一 `label` 再接続と世代管理**
   - `join` により同一 `label` の参加者が再接続すると、`resumed: true` とともに保持中のタスク（`your_tasks`）が返され、`gen` が繰り上がる。新しい `gen` で `claim` を再取得できる。
2. **黒板（SQLite）への進捗・証拠・要約の永続化**
   - [src/core.mjs](../../src/core.mjs) の `plan`（`update_summary` / `add_evidence`）が `goals.summary` / `goals.next_step` と `evidence` テーブルを更新し、`report` が `reports` テーブルに `progress` / `result` 本文を保存する（`report` 引数の `evidence` 配列は `kind='result'` 時に `evidence` テーブルへ保存される）。
   - これらが SQLite に保存されるため、`runService` の停止・再起動を跨いでも同じ `IDLESHIFT_HOME` 上でデータが保持される。
3. **リース期限切れによる別 AI への再配布と履歴参照**
   - [src/core.mjs](../../src/core.mjs#L1900-L1918) の `tick()` により、`lease_expires <= now` となったタスクが解放される（`mode='read_only'` は `open`、`mode='writes'` は `needs_check`）。
   - [src/core.mjs](../../src/core.mjs#L1801-L1822) の `get()` により、別の参加者が `goal:<ID>`、`task:<ID>`、`reports:<TASK>`、`evidence:<GOAL>` を通じて前任者の進捗報告・証拠・現在地要約を参照できる。

---

## 2. テストで確認した事実

[tests/evidence-continuity.test.mjs](../../tests/evidence-continuity.test.mjs) は、本番環境（AppData / 稼働中サービス）に一切触れず、一時ディレクトリ（`tmpDir`）上の `runService` と実リレープロセス（`bin/idleshift.mjs mcp`）を用いて以下を順に検証した。

1. **シナリオ1（会話破棄後の同一 `label` 再接続）**
   - 参加者 A（`app-a`, `label='worker-a'`）がファシリテート後に作業タスク（`T-2`, `mode='read_only'`）を `claim` し、`plan` で要約（`update_summary`）と証拠（`add_evidence`）を登録、さらに `report(kind='progress')` で進捗を送信。
   - クライアントプロセスを強制終了（会話破棄を模擬）し、新しいリレープロセスから同一 `label='worker-a'` で `join` した結果、`participant` ID が維持され `resumed: true`・`your_tasks` に `T-2` が復元され、`gen` が繰り上がった。新 `gen` で `claim` を再取得し、`get('reports:T-2')` で過去の `progress` を取得できた。
2. **シナリオ2（サービス再起動を跨いでの永続性）**
   - A の接続を閉じたうえで `svc.stop()` によりサービスを停止し、同じ `IDLESHIFT_HOME` で `runService` を再起動した。
   - 再起動後の接続で `join`・`get('goal:G-1')`・`get('evidence:G-1')`・`get('reports:T-2')` を呼び出し、ゴール要約（`Step1完了済み、Step2待機`）、登録済み証拠、進捗報告、および保持タスクがすべて維持されていることを確認した。
3. **シナリオ3（リース期限切れ後の別クライアント・別 AI への引き継ぎ）**
   - A を切断した状態で、`sleepGap` 判定を踏まないよう 30 秒刻みで 31 分（デフォルト `lease_minutes: 30` を超過）進めて `tick()` を実行し、`T-2.state` が `'open'` へ戻ることを確認した。
   - 別クライアント `app-b`（`label='worker-b'`）が `join` → `next` → `claim` で `T-2` を引き受け、`get('task:T-2')` / `get('reports:T-2')` / `get('evidence:G-1')` / `get('goal:G-1')` で A の進捗・証拠・要約を取得したうえで `report(kind='result')` を送信し、`T-2.state === 'accepted'` で完了した。

---

## 3. 実行結果

生ログ: [docs/evidence/raw/continuity/2026-11-12/test-output.txt](raw/continuity/2026-11-12/test-output.txt)

```text
✔ continuity (1)-(3): same-label resume, service restart persistence, lease-expired handoff to another AI (900.351ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 996.8761
```

---

## 4. 限界・未実証の範囲

- **黒板外の状態は引き継がれない**: 引き継がれるのは黒板（`progress` / `evidence` / `summary` / `handoff` 等）およびワークスペースに書き出された内容に限られる。破棄された会話のコンテキスト内にのみ存在した思考や未記録の判断は失われる。
- **実アプリ間の実機引き継ぎは未実施**: 本検証は一時 `IDLESHIFT_HOME` 上の `runService` と `bin/idleshift.mjs mcp` による自動再現であり、実際の異なる 2 種類の AI デスクトップ/CLI アプリを用いた実機引き継ぎは未実施（`docs/evidence/plan.md` の区分に従い「条件付き」と判定）。
- **対象タスク種別の範囲**: シナリオ 3 ではリース切れ後に直接 `open` へ戻る `mode='read_only'` タスクで再オファーを検証した（`mode='writes'` タスクのリース切れは `needs_check` へ遷移する）。
