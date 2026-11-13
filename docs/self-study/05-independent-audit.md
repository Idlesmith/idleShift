# 01 技術監査の別AIによる独立点検報告（D-7）

- **点検者**: P-20（agy-flash#2）／T-279／2026-11-13
- **対象文書**: `docs/self-study/01-technical-audit.md`（作者: P-6）
- **点検方法**: リポジトリのソースコード（`src/`）、テスト、package.json、最新コミットログを直接確認し、P-6 の記述項目ごとに判定（確認できた / できない / 誤り）を付与。

---

## 1. 監査項目ごとの点検結果

| 項目 | 01-technical-audit.md の記述 | 判定 | 点検メモ・確認コード |
|---|---|:---:|---|
| **アーキテクチャ** | 中継（relay.mjs）、常駐サービス（service.mjs）、中核（core.mjs）、SQLite（db.mjs）、GUI（gui/app.js）、hosts.mjs、adapters.mjs | **確認できた** | すべて src/ 配下に存在し責務分担が記述通り動作。dependencies ゼロも package.json で確認。 |
| **MCPツール数** | 標準ツール7個（join, next, claim, get, report, plan, status） | **確認できた** | `src/tools.mjs` の TOOLS 定義配列（7件）と完全一致。 |
| **対応AI環境** | Claude Code CLI, Claude Desktop (Codeタブ), Codex CLI 実証済み。Claude Desktop (チャット), Antigravity は未検証。Mac/Linux 未対応。 | **確認できた** | `hosts.mjs` の実装および README の検証表と一致。P-6自身がCodeタブから参加した事実も確認。 |
| **タスク状態機械** | open -> offered -> claimed -> reported -> accepted。書き込み期限切れは needs_check。 | **確認できた** | `src/core.mjs:4-8, 1736` の `releaseTask` で `mode === 'writes' ? 'needs_check' : 'open'` と一致。 |
| **進行役 streak** | 根拠なしで3回続くと人に戻す（facilitator_streak >= b.max_no_progress） | **確認できた** | `src/core.mjs:733-735`（streak >= b.max_no_progress で raiseDecision 'no_progress'）と一致。 |
| **next の待機学習** | 初回50秒、倍々、上限3600秒、途絶え8割上限（core.mjs:804） | **確認できた** | `src/core.mjs:799-806` の `holdFor` 計算式で完全に確認（訂正済み内容も正しい）。 |
| **git ワークツリー分離** | 構想段階（G-14） | **更新要** | 執筆時点は構想段階だったが、現在 B-2 中核実装（`src/git.mjs`, `src/core.mjs`, `tests/git-isolation-core.test.mjs`）が完了し、マージ画面（B-3）が進行中。 |
| **自動テスト件数** | READMEは140件、テストファイル23本 | **確認できた** | 現在は G-14/15/17/18 の追加テストを含め、`node --test` で 181件 pass を確認。 |
| **外部通信なし** | コードに外部通信は見当たらないがプロセス全体の検証は未実施 | **確認できた** | `src/` 配下に http.request, fetch, child_process による外部通信（push/fetch/clone）は存在しない。 |

---

## 2. D-2 開発履歴（02-history.md）の DB 数値再確認

本番 `%LOCALAPPDATA%\IdleShift\idleshift.db`（読み取り専用）および現行テスト・イベントログを照合:
- **PRJ-3 全タスク数**: 66タスク（accepted 62件、取消3件除き 受理率 98.4%）
- **レビュー件数**: 33回（review_accept 22件、review_rework 11件、差戻し率 33.3%）
- **注意点確認**: 各AIアプリへの「開始の一言」の貼り付けなど、人間が手動で行った初期操作はDBに記録されないため、「自律稼働時間であっても人手による初期トリガーは存在する」という客観的な注記が必須であることを確認。
