# 別PC動作確認チェックリスト（Git 分離・マージを含む）

## 前提メモ
- 「PR 相当」の機能はローカルで完結する：タスクごとに `git worktree` と `idleshift/<タスクID>` ブランチを作り、人が GUI でマージまたは破棄する（`src/git.mjs`、`src/core.mjs` の mergeTaskWorktree）。push・fetch・GitHub API は使わない。
- GitHub 側は `.github/`（PR/Issue テンプレート、CI `test.yml` = windows-latest / Node 24 / `npm test`）のみ。
- G-19 で対応済み（2026-11-13）：
  1. git の user.name / user.email が未設定でも、no-ff マージは一時識別情報（IdleShift &lt;idleshift@localhost&gt;）で通る。AI 向け assignment に `git -c user.name=... -c user.email=... commit` の注意が出る。
  2. git 2.38 未満：fast-forward 可能なら競合なし判定、それ以外は旧形式 `git merge-tree <base> <a> <b>` で競合を検出。判定できなければ版数入りのエラー。
  3. マージ／破棄後に作業フォルダーやブランチの削除に失敗したら、`worktrees.last_error`・イベント・GUI（トースト、タスク詳細の「後片付けエラー」）に残る。
  4. detached HEAD：開始時に detached なら `target_branch=null` で作成し AI に注意を出す。マージ時にメインが detached なら `detached_head` で拒否（何も変更しない）。
  5. ゴールが全部完了済み、または 1 件も無くても add_goal できる（goal 省略時は安全な既定の委任範囲）。

## A. インストール・起動
- [ ] `node -v` が 24 以上
- [ ] `git --version` を記録（2.38 未満なら C の旧 git 項目も確認）
- [ ] `IdleShift.bat`（または `npm start`）で GUI が開く
- [ ] データフォルダーが作られ、再起動後もプロジェクトが残る
- [ ] UI 言語切替（ja/en）が反映される
- [ ] `npm test` が全件成功

## B. AI クライアント接続
- [ ] GUI の接続手順で Claude Code / Codex 等に MCP 登録できる
- [ ] 各クライアントから `join` → `next` → `claim` → `report` が通る
- [ ] Claude デスクトップ（パッケージ版）経由でも service.json が見つかる（relay）
- [ ] 参加者が GUI の参加者一覧に表示される
- [ ] ゴールが無い／全部完了の状態で、チャットから AI が add_goal でき、GUI で「AI作成」と分かる

## C. Git 分離・マージ
- [ ] writes タスクの claim で `workspace.kind=git_worktree` が返り、`idleshift/T-x` ブランチができる
- [ ] メインフォルダーは変更されない／同時 2 タスクは別ワークツリー
- [ ] 非 git フォルダー・git_isolation=off は shared_root にフォールバック
- [ ] GUI に差分（コミット数・stat）が出る
- [ ] accept 後のマージ：ff / no-ff とも成功し、ワークツリーとブランチが消える
- [ ] **user.name/email 未設定の PC**：AI のコミットが注意文どおりにでき、no-ff マージが IdleShift 名義で通る
- [ ] **git 2.38 未満の PC**：競合なしのマージが通り、競合ありはファイル名つきで拒否される
- [ ] メインに未コミット変更 → 拒否＋ファイル一覧
- [ ] メインが別ブランチ → branch_mismatch で拒否
- [ ] **メインが detached HEAD** → detached_head で拒否、ブランチに戻すとマージできる
- [ ] 競合あり → 競合ファイル名つきで拒否、メインは無変更
- [ ] 後片付け失敗（作業フォルダーのファイルを別アプリで開いたまま等）→ 警告トーストと「後片付けエラー」表示、孤立一覧から再削除できる
- [ ] 「破棄」でワークツリー・ブランチ削除／キャンセル時の自動片付け
- [ ] 再起動後もワークツリー状態が引き継がれる
- [ ] 長いパス・日本語を含むパスで動く

## D. GitHub リポジトリ運用
- [ ] 別 PC で clone → `npm test` 成功（CRLF/LF 差で落ちない）
- [ ] マージ結果を人が手動 push → GitHub Actions `test` が緑
- [ ] PR 作成時に PR テンプレートが展開される
- [ ] IdleShift が push/fetch を勝手に行わない（remote に変化なし）

## E. 運用
- [ ] 判断待ち（decision_needed / permission）が GUI に出て回答できる
- [ ] 停止ボタンで AI 側 `next` が stop を受け取る
- [ ] usage limit 報告 → 再開時刻表示
- [ ] プロジェクトのアーカイブ／削除
- [ ] 通知（IDLESHIFT_NOTIFY）オン/オフ
- [ ] 依存先がマージ待ちのとき、人がそれに気づける（現状は表示が弱い：要改善）
