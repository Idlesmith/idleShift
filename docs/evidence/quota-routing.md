# 主張 (b) 実証レポート：使用枠の申告と制限が提示先をどう変えるか

- **対象主張**: 主張 (b)「使用枠と再開時刻を見て割り当てる」
- **分類**: **条件付き**（`docs/evidence/plan.md` の基準に基づき、インメモリ DB を用いた自動再現テストは全項目合格。ただし実アプリ間の 3 クライアント実測録画・実 DB スナップショットは未取得）
- **実施日**: 2026-11-12
- **再現テスト**: [tests/evidence-quota-routing.test.mjs](../../tests/evidence-quota-routing.test.mjs)
- **生データ**: [docs/evidence/raw/quota-routing/2026-11-12/test-output.txt](./raw/quota-routing/2026-11-12/test-output.txt)

---

## 1. コード上の仕組み（`src/core.mjs`）

| 機能 | 箇所 | 挙動 |
| --- | --- | --- |
| 使用枠の記録 | `setQuota` (`src/core.mjs:389-403`) | `ok` / `low` / `known` は `'known'`、`limit` / `limit_reported` は `'limit_reported'` として保存。`reset_at` と `detail`（例: `残り少・使用 X%`）を記録する |
| 状態判定・回復 | `quotaView` (`src/core.mjs:405-413`), `limited` (`src/core.mjs:415`) | `limit_reported` は `reset_at ?? reported_at + limitFallback`（`blocked_until`）まで `limited() === true`。`until` 経過後は `'stale'` になり 1 回分の試行を許可する。`known` も `quotaStale` 経過後は `'stale'` になる |
| 5 時間／7 日上限 | `usageRows`, `usageTotals`, `usageBlock` (`src/core.mjs:578-605`) | `(project_id, label)` 単位で `claims_5h`, `minutes_5h`, `claims_7d`, `minutes_7d` を集計し、`participant_profiles` の上限を超えると `usageBlock` が非 null になる |
| 提示前の除外 | `immediate` (`src/core.mjs:1039-1060`) | `usageBlock` または `limited(p.client)` が真の場合、`immediate()` は `null` を返し新規オファーを出さない（既に `claimed` 中のタスク継続のみ許可） |
| 提示優先度 | `pickOffer` (`src/core.mjs:1006-1020`), `eligible` (`src/core.mjs:952-984`) | `prefer` 一致（+2）、`t.tier === mine`（+1）、`created_at, id` 順で候補を並べる。`tierAllows` で資格を満たさないタスクは除外される |
| `kind='limit'` 報告 | `report` (`src/core.mjs:1338-1345`), `releaseTask` (`src/core.mjs:714-721`) | `client` を `limit` 状態にし、対象タスクへ `prefer = p.id.toLowerCase()` と `handoff` を設定した上で `releaseTask(t, 'open', 'limit')` で解放する |

---

## 2. 再現テストで確認した事実（`tests/evidence-quota-routing.test.mjs`）

`makeCore()` によるインメモリ DB（本番 DB 非接触）に 3 参加者（`app-a`, `app-b`, `app-c`）を参加させ、以下を検証した。

1. **`limit` と `reset_at` の申告による停止と再配分**
   - `app-a` が `work-1`（`tier: 'any'`）を受領・着手した状態で `kind: 'limit'`, `reset_at: +10分` を報告すると、`client-a` は `state: 'limit_reported'`、`limited('client-a') === true` となり、`app-a` への `next` は `none` になった。
   - **実装上の重要挙動**: `kind='limit'` は対象タスクに `prefer = pA.toLowerCase()` を付与して `open` へ戻すため（`src/core.mjs:1341`）、直後の `preferGrace` 期間内は `app-b` にも `work-1` が提示されず、`preferGrace` 経過後（`reset_at` より前）に `app-b` へ再提示された。
2. **`quota: { state: 'low', used_percent: 90 }` の扱い**
   - `app-b` が `work-1` を完了報告する際に `quota: { state: 'low', used_percent: 90 }` を添えると、`quotaView('client-b').state === 'known'`、`detail` に `残り少` が記録されたが、`limited('client-b') === false` であり、後続の割り当てブロックは発生しない（アドバイザリ／表示用途）。
3. **人手設定の 5 時間上限（`limit_5h_claims: 1`）と `tier` の相互作用**
   - `app-b`（`tier: 'worker'`, `limit_5h_claims: 1`）は 1 件完了後に `usageBlock` により `next` が `none` になった。
   - `app-c`（`tier: 'worker'`）は新規タスク `work-2`（`tier: 'any'`）を受領・完了したが、`work-senior`（`tier: 'senior'`）は `tierAllows` により提示されなかった。
4. **`reset_at` 経過後および 5 時間窓経過後の回復**
   - 仮想時計を `reset_at` 超過まで進めると、`client-a` は `state: 'stale'`、`limited('client-a') === false` へ遷移し、`app-a`（`tier: 'senior'`）に `work-senior` が提示された。
   - 仮想時計を 5 時間超進めると、`app-b` の `usageBlock` が `null` に戻った。

---

## 3. 実行結果

`node --test C:\AI_HUB\conclavity\tests\evidence-quota-routing.test.mjs` の出力（生データ: [test-output.txt](./raw/quota-routing/2026-11-12/test-output.txt)）：

- `tests 1` / `pass 1` / `fail 0` / `duration_ms 93.0638`

---

## 4. 限界と未確認事項

- **アドバイザリ申告への依存**: Conclavity / IdleShift は各 AI アプリやベンダー API の実トークン残高を直接読み取らない。`quota: { state: 'low' }` は状態表示のみで自動停止は行わず、停止トリガーはクライアント側の自己申告（`kind: 'limit'` / `quota.state: 'limit'`）または人手設定の `participant_profiles` 上限（`usageBlock`）である。
- **`preferGrace` による即時再配分の遅延**: `kind: 'limit'` で戻されたタスクは報告者への `prefer` が付くため、他にタスクが無い場合は `preferGrace` 経過まで別ワーカーへ渡らない。
- **実環境未検証**: 本実証は `makeCore()` 上の再現テストであり、実アプリ 3 台での長時間実測録画は未実施（よって分類は `条件付き`）。
