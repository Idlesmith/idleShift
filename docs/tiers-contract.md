# 階層と使用量：実装契約（G-3 / T-55）

- 状態：設計（実装の前提。変更するときはこの文書を先に直す）
- 作成：claude-opus（T-55）、2026-11-10
- 対象タスク：T-56（プロファイル・使用量・移行）、T-57（割当）、T-58（GUI・API）、T-59（MCP公開）、T-60（統合）

## 0. 原則

- **数えるのは IdleShift、判断は進行役AI、決めるのは人。** 階層と上限は人だけが設定する（MCPから変更する手段は作らない）。AIの自己申告（`report.quota`）は従来どおり補助情報で、上限判定には使わない。
- **未設定なら従来と完全に同じ。** 階層もポリシーも上限も設定していないプロジェクトでは、提示順・提示可否・応答の既存フィールドが1つも変わらない（追加フィールドは増えてよい）。既存99件のテストは期待値を弱めず維持する（ただし人の明示指示 E-76 に基づき、参加者の同一性を「接続＋名前」単位に変更したことに伴う `tests/revoke-label-review2.test.mjs` の2件のみ新仕様に合わせて更新）。
- 計測できるのは **引受け件数と作業時間** だけ。トークンや料金は測れないので、画面にもそう書く。

## 1. 用語と順位

| 階層 | 順位 | 意味 |
|---|---|---|
| `planner` | 3 | 要件定義・進行役 |
| `senior` | 2 | 上位ワーカー |
| `worker` | 1 | 量産ワーカー |
| 未設定（`null`） | — | 従来どおり、どのタスクも受けられる |

タスクの `tier` は `planner / senior / worker / any`（既定 `any`）。

**受けられる条件**：参加者の階層が未設定、またはタスクが `any`、または `順位(参加者) >= 順位(タスク)`。下位が上位のタスクを受けるのは §4 の降格（または進行役タスクの猶予後フォールバック）だけ。

## 2. データ（スキーマ v4。T-56 が担当）

`src/db.mjs` に `V4` を追加し `SCHEMA_VERSION = 4`。移行前バックアップは既存機構（`pre-migrate-v3-*.db`）。

```sql
CREATE TABLE participant_profiles(
  project_id TEXT NOT NULL, label TEXT NOT NULL,
  tier TEXT,                                   -- planner|senior|worker|NULL
  limit_5h_claims INTEGER, limit_5h_minutes INTEGER,
  limit_7d_claims INTEGER, limit_7d_minutes INTEGER,   -- NULL は上限なし
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, label));
CREATE TABLE usage_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL, label TEXT NOT NULL, participant TEXT NOT NULL,
  task_id TEXT NOT NULL, gen INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT,
  UNIQUE(task_id, gen, participant));
CREATE INDEX usage_label ON usage_log(project_id, label, claimed_at);
ALTER TABLE tasks ADD COLUMN tier TEXT NOT NULL DEFAULT 'any';
ALTER TABLE tasks ADD COLUMN senior_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN tier_policy TEXT NOT NULL DEFAULT '{}';
```

- プロファイルは **(プロジェクト, 名前 label)** にひも付く。再参加しても同じ名前なら保持。`codex-sol#2` のような自動の別名は別の名前なので未設定扱い（画面で設定すれば効く）。
- 使用量は **名前単位** で数える（同じ名前の会話が入れ替わっても合算）。

## 3. 使用量の数え方（T-56）

| 出来事 | 記録 |
|---|---|
| 提示を受けて初めて `claim` した（`mine` でない claim） | `usage_log` に1行（`claimed_at=now`）。**件数+1** |
| 自分の担当を再取得する claim、`join` による再開、`progress` | 記録しない |
| `report` の result / decline / blocked / decision_needed / limit | その行の `ended_at=now`, `outcome=kind` |
| 担当解除（期限切れ・取消・参加取消・復元時の解除） | `ended_at=now`, `outcome=released` |
| stale・重複の報告 | 何もしない |

- **作業時間** ＝ `(ended_at ?? now) - claimed_at` の合計（分、切り上げ）。窓は直近5時間・直近7日で、`claimed_at` が窓内の行を数える。
- スリープ検知（既存 `tick` の sleep_detected）中の空白は作業時間から引かない（単純化。画面に「スリープ中も含む」と書く）。
- **復元**：`usage_log` はDB内なのでバックアップ時点へ戻る。復元直後は使用量が少なく見えることを README に書く（安全側に倒す必要は薄い：上限は人の目安であり課金を止める装置ではない）。

**上限判定** `usageBlock(projectId, label)` → `null` か `{ reason, until }`。設定済みのどれか1つでも `>=` なら提示しない。`until` は窓から最古の行が抜ける時刻。**作業中の担当は止めない**（提示を止めるだけ）。

## 4. 割当（T-57）

`tier_policy`（プロジェクト単位、JSON）：

```json
{ "downgrade_after_minutes": null }
```

- `null`（既定）：下位へは降ろさない。
- 数値 N：タスクが `open` になってから N 分たっても、受けられる上位階層の参加者が **待機していない（または全員上限中）** なら、`kind='work'` の作業タスクに限り 1つ下の階層も受けてよい。降格で引き受けた場合、そのタスクに `senior_review=1` を付け、報告後のレビュータスクは `tier='senior'`・作成者除外で必ず作る（`review` 指定の有無に関わらず）。
- **レビュータスクの非降格と適用時検証**：`kind='review'` のレビュータスク自体は降格ポリシーの対象外（`tierGate` が `'no'` を返すため `worker` には提示も引受けもされない）。また、`report`（`applyReview`）および `plan` の `accept` 実行時にも、対象タスクが `senior_review=1`（またはレビュータスクが `tier='senior'`）である場合、明示的に `worker` 階層の参加者による承認・レビュー報告は `tier_mismatch` で拒否する（`senior`・`planner`、および互換規則により階層未設定 `null` の参加者は実行可能）。

**提示の優先順**（`pickOffer` / `deliver`）：

1. 既存の `prefer`（担当の希望）。
2. 階層が **完全一致** する参加者を優先する。上位の参加者（または階層未設定の参加者）が tier 付きタスクを取るのは、そのプロジェクトに一致する階層の参加者が1人もいない場合はすぐ、いる場合はそのタスクが `open` になってから既存の `preferGrace`（5分）たっても一致する階層の参加者が待機していない（または上限中・除外の）とき。上位を量産作業で使い切らないため。
3. 階層を持つ参加者は、複数の未着手タスクがあるとき自分の階層と一致するタスクを先に提示される。それ以外は従来順。

**進行役タスク**：プロジェクトに `planner` の参加者（取消・削除されていない）が1人以上いるとき `tier='planner'` で作る。`planner` が上限中・不在で `preferGrace`（5分）を過ぎたら、誰でも受けられる（進行役は止めない。この場合、進行役の成果に降格の `senior_review` は付かない）。`planner` がいなければ従来どおり `any`。

**上限中の参加者**：`immediate` で提示しない。`next` の `none` 応答に `reason`（「人が設定した使用量の上限に達しています」）と `limited_until` を入れる（既存の上限エラー時の形に合わせる）。

`offerableCount`（CLIアダプターの起動判定）も同じ規則を通す。

## 5. 人の操作（T-58）

Core（T-58 が追加）：

- `setProfile(projectId, label, { tier, limit_5h_claims, limit_5h_minutes, limit_7d_claims, limit_7d_minutes })` — 値の検証（tier は4値のみ、上限は 1〜10000 の整数か null）。
- `setTierPolicy(projectId, { downgrade_after_minutes })` — null か 1〜1440。
- `usageView(projectId)` → 名前ごとに `{ label, tier, used: { claims_5h, minutes_5h, claims_7d, minutes_7d }, limits, blocked: usageBlock(...) }`。T-56 が実装、T-58 は呼ぶだけ。

`service.mjs` の API に `setProfile` / `setTierPolicy` を追加。`snapshot()` の参加者に `tier` と `usage`、プロジェクトに `tier_policy` を追加。

GUI（「接続」タブの各プロジェクトの参加者カード）：参加者ごとに階層の選択と4つの上限入力、直近の使用量・上限までの残り・「提示を控え中（〜時刻まで）」を表示。プロジェクトに降格ポリシーの入力。説明文に「数えているのは引受け件数と作業時間で、料金やトークンではありません」。文字列は既存どおり textContent で入れる。

## 6. MCP 公開（T-59）

- `plan` の `add_task` に `tier`（`planner|senior|worker|any`）。不正値は拒否。`tools.mjs` の説明も更新。
- `boardView` の各参加者に `tier`、`offers_paused`（上限中なら `true` と `until`）、`used_5h`（件数）を追加。各タスクに `tier`。
- `header` に `your_tier`（未設定なら省略）。
- `assignment.program` に `tier` と、降格で受けた場合 `downgraded: true`（「上位のレビューが付く」旨）。
- 進行役タスクの本文（`FACILITATOR_BODY`）に「階層を使うなら add_task に tier を付ける。board の参加者の tier と offers_paused を見て prefer を決める」を1行追加。

## 7. 担当範囲（同時編集の境界）

| タスク | ファイル・関数 | 専用テスト |
|---|---|---|
| T-56 | `db.mjs`（V4）、`core.mjs` に新設する「profiles & usage」節（`recordClaimUsage` `endUsage` `usageBlock` `usageView`）と、`claim` `report` `releaseTask` `invalidateAfterRestore` `revokeParticipant` からの呼出し1行ずつ | `tests/tier-usage-v4.test.mjs` |
| T-57 | `core.mjs` の `insertTask`（tier・senior_review）、`eligible`、`pickOffer`、`deliver`、`immediate`、`ensureFacilitators`、`report` のレビュー作成部分、`offerableCount` | `tests/tier-offer.test.mjs` |
| T-58 | `core.mjs` に `setProfile` `setTierPolicy` と `snapshot` の追加分、`service.mjs` の API、`gui/app.js` の `viewConnect` | `tests/tier-gui-api.test.mjs`（実サービスのAPI） |
| T-59 | `tools.mjs`、`core.mjs` の `plan`（add_task の tier 受け渡し）・`boardView`・`header`・`assignment`・`FACILITATOR_BODY` | `tests/tier-mcp.test.mjs` |
| T-60 | README・統合・コミット | 全体 |

順序：**T-56 が先**（テーブルと `usageBlock` が他の前提）。T-57・T-58・T-59 は T-56 の受入後に並行。T-60 は全部の後。

## 8. 互換性テスト（各担当が自分の専用テストに入れる）

- 階層・上限・ポリシー未設定で、既存 `core.test.mjs` の割当手順と同じ結果になる（T-57）。
- v3 のDBを開くと v4 へ移行し、既存タスクは `tier='any'`、既存プロジェクトは `tier_policy='{}'`（T-56）。
- 未設定の参加者は `planner` タスク以外も含め何でも受けられる（T-57）。

## 9. 人に確認したいこと（実装を止めない既定値つき）

- 降格の既定は「しない」。量産層に積極的に回したい場合はプロジェクト設定で分を入れる。
- 上限の既定はすべて「なし」。

## 10. 検証対応表（G-3 統合検証 T-60）

全140件の自動テスト（`node --test tests/*.test.mjs`）が合格（既存99件＋新規41件。既存テストは人の明示指示 E-76 による `tests/revoke-label-review2.test.mjs` の仕様更新を除き無変更）。

| 要件 / 項目 | 専用テストファイル | 実装タスク・受入レビュー | 先行失敗 → 実装後合格 |
|---|---|---|---|
| 要件1：参加者の階層（`planner`/`senior`/`worker`/未設定、名前単位の保持、GUI手動設定のみ） | `tests/tier-usage-v4.test.mjs`, `tests/tier-gui-api.test.mjs` | T-56 (T-63受入), T-58 (T-66受入) | T-56: 12失敗→12合格 / T-58: 3失敗→4合格 |
| 要件2：タスクの階層（`add_task` の `tier`、既定 `any`、進行役の `planner` 優先と救済） | `tests/tier-offer.test.mjs`, `tests/tier-mcp.test.mjs` | T-57 (T-65受入), T-59 (T-67受入) | T-57: 12失敗→15合格 / T-59: 2失敗→2合格 |
| 要件3：階層別割り振り・優先猶予・降格フォールバック＋`senior` レビュー必須（提示後の降格条件再検査・レビュータスク非降格・`plan accept` / `report` での `worker` 承認拒否を含む） | `tests/tier-offer.test.mjs`, `tests/tier-gui-api.test.mjs` | T-57 (T-65受入), T-58 (T-66受入), T-60 (T-68/T-69差戻し対応) | T-57: 12失敗→15合格 / T-58: 3失敗→4合格 / T-60追加: 3失敗→3合格 |
| 要件4：使用量の計測（5時間・7日窓、引受け件数・作業時間）と上限による提示停止 | `tests/tier-usage-v4.test.mjs`, `tests/tier-offer.test.mjs` | T-56 (T-63受入), T-57 (T-65受入) | T-56: 12失敗→12合格 / T-57: 12失敗→15合格 |
| 要件5：見える化（GUI表示・残り表示、`board`/`header`/`assignment` への公開） | `tests/tier-gui-api.test.mjs`, `tests/tier-mcp.test.mjs` | T-58 (T-66受入), T-59 (T-67受入) | T-58: 3失敗→4合格（実ブラウザー確認済） / T-59: 2失敗→2合格 |
| 要件6：互換性（v3→v4移行＋自動バックアップ、未設定時は従来と完全に同一動作） | `tests/tier-usage-v4.test.mjs`, `tests/tier-offer.test.mjs` | T-56 (T-63受入), T-57 (T-65受入) | v3→v4移行テスト＋未設定互換テスト合格、既存99件（E-76の明示更新2件を含む）全合格 |
| 追加対応：参加取消の名前単位化・共有接続での会話分離・アプリ単位ブロック・不要参加者の削除 | `tests/participant-cleanup.test.mjs`, `tests/revoke-label-review2.test.mjs` | T-62 (T-64受入) | 2失敗→5合格（`revoke-label-review2` 2件と合わせ全合格） |
