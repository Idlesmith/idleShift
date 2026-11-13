# 04 訴求ポイントと広報・公開戦略（D-4 訂正版）

- **担当**: P-20（agy-flash#2）／T-279／2026-11-13
- **参照・点検情報**:
  - `docs/self-study/01-technical-audit.md`（D-1 技術監査）
  - `docs/self-study/02-history.md`（D-2 開発履歴）
  - `docs/self-study/03-competitors.md`（D-3 競合比較）
  - `docs/evidence/waiting-cost.md`（F-4 待機コスト測定）
  - `docs/evidence/quota-routing.md`（F-2 使用枠配分測定）
  - `docs/evidence/continuity.md`（F-3 継続性測定）
  - `docs/evidence/f6-independent-audit.md`（F-6 独立点検）
  - `docs/security-review.md`（C-5 セキュリティ点検）
- **改訂の経緯**: D-5（T-239）における P-6 の相互点検指摘8件を精査し、誇張・誤りを修正して実測データ・最新コードと完全に整合させた。

---

## 1. 訴求ポイント10選（詳細評価・訂正版）

| No | 英語コピー / 日本語訳 | 想定ターゲット | 技術的根拠（D-1/D-2/F実証） | 競合との差（D-3） | 魅力度 (1-5) | 根拠の強さ (1-5) | 誇大広告になる危険と予防策 |
|---|---|---|---|---|:---:|:---:|---|
| **1** | **Turn idle subscriptions into working agents**<br>余っている定額AI枠を、働くエージェントに変える | 個人開発者、月額定額プラン（Claude Pro/Team, ChatGPT Plus/Team等）加入者 | `src/core.mjs` の待機機構（holdFor/sleepGap）、`bin/idleshift.mjs`。常駐プロセスがタスクを管理し、AIアプリを標準MCPサーバー経由で協調呼び出し（01 §2） | ConnectR / stringwork / Chorus 等はAPI従量課金前提または自社管理CLI起動型。手元の既存アプリをMCPで繋ぐ点に特化（03 §2） | **5** | **4** | **危険**: 「放置で何でも作ってくれる」と誤解される。<br>**予防**: 人の定期的なレビュー・判断が必須であり、各社規約（自動化の範囲）を遵守する旨を明記。 |
| **2** | **Reset the chat. Not the progress**<br>チャットを捨てても、進捗は消えない | 長文チャットでコンテキスト溢れや暴走に悩む開発者 | `src/db.mjs`, `src/core.mjs`。進捗・ゴール・根拠・タスク状態はSQLiteに永続化。同一ラベル再接続で直前のコンテキスト（task, gen）が復元（`tests/evidence-continuity.test.mjs` 合格） | セッション完結型ツールではリセットで文脈が失われる。外部サーバー不要でローカル単一DB集中管理（03 §4） | **5** | **4** | **危険**: 「思考ログが100%引き継がれる」と誤解される。<br>**予防**: 引き継がれるのは「タスクの成果・根拠・ゴール状態」であり、未記録の思考ログは失われる旨を明記。 |
| **3** | **Built and improved with itself**<br>自らを開発・改修し続けて育った黒板 | 自律エージェント、ドッグフーディングに興味があるエンジニア | `docs/self-study/02-history.md`。2026-11-10〜11-12（49.5時間）のPRJ-3（Conclavity自己改修）上で全66タスク中62件が自己改修により受理・完了された実証記録 | 競合ツールの多くは自己改修データを未公開。IdleShiftは自己改修イベントログとレビュー差戻しログ（33.3%）を公開可能（02 §3） | **4** | **4** | **危険**: 「初版から100%AIが自律開発した」と誤認される。<br>**予防**: 初版は単独作成であり、「Built and improved with itself（改修と発展を共に行った）」を上限表記とする。 |
| **4** | **Reduced polling between tasks**<br>仕事がない時の呼び出し頻度を抑制（毎時約11〜24回） | ポーリングによるトークン浪費を警戒する開発者 | `src/core.mjs` の `next`（holdInitial=50秒、倍々、各アプリ上限150〜333秒）。毎分ポーリング（毎時60回）に比べ呼び出し頻度を毎時11〜24回程度に低減 | 一般的なAutoGPT系は毎分ポーリングでトークンを浪費。IdleShiftはロングポーリングで回数を削減 | **3** | **2** | **訂正（D-5指摘1）**: F-4実測により3600秒待機は未達、1時間約11〜24回の呼び出しが発生。「トークン消費ゼロ」は取り下げ、「呼び出し頻度低減（実トークン消費は未実測）」と訂正。 |
| **5** | **Quota-aware routing: respect limits and resets**<br>使用枠の上限と回復時刻を見て、賢く配分 | 複数モデルを併用しレート制限に直面するユーザー | `src/core.mjs:389-415, 1039-1060`。`kind: 'limit'` 報告による `reset_at` までの新規提示ブロック、人手設定の5h/7d上限（`usageBlock`）の実装（`tests/evidence-quota-routing.test.mjs` 合格） | ConnectR、stringwork、Chorus等の調査では「AI側のレート制限を考慮した配分」は見当たらない独自の強み（03 §5） | **5** | **4** | **危険**: 「各社残トークンを自動検知する」と誤解される。<br>**予防**: ベンダー残高の直接取得ではなく、AIの自己申告および人手設定による制御であることを明記。 |
| **6** | **Git-isolated workspaces (In Progress / Core Ready)**<br>タスクごとのgit分離：中核実装済み（マージ画面は後続） | 複数エージェントによるファイル衝突を懸念するチーム | `src/git.mjs`, `src/core.mjs`, `docs/git-isolation.md`。書き込みタスクごとのワークツリー自動作成・ブランチ分離・同名拒否を実装済み（`tests/git-isolation-core.test.mjs` 5件合格） | ConnectRはワークツリー分離を持つが、多くのローカル協調ツールは同一作業ツリー直接編集かファイルロックのみ（03 §2） | **5** | **3** | **訂正（D-5指摘3）**: B-2中核実装は完了したがGUIマージ画面（B-3）は未実装。「マージ画面は後続実装中であり、現在はコア分離が動作」と条件を明記。 |
| **7** | **Safety by design: human authority preserved**<br>全権限フラグ不要。権限拡大と完了判定は人だけの特権 | 自律AIの暴走（外部送信、ファイル破壊）を恐れるエンジニア | `src/core.mjs:240-270, 460-498`。委任範囲の拡大や完了判定は人手でのみ可能。AIによる `add_goal` は権限縮小のみ許可 | CLI引数で `--dangerously-skip-permissions` を要求するエージェントツールと一線を画し安全を重視（01 §6） | **4** | **3** | **訂正（D-5指摘4）**: docs/security-review.md の指摘 S-1（AI文のhuman誤認）および S-5（停止ゴールひな形）が未修正であるため、修正完了まで根拠の強さを3とする。 |
| **8** | **Zero npm dependencies, single SQLite engine**<br>npm依存ゼロ。Node内蔵SQLiteで軽快に動く | 重厚なDocker環境やPythonの依存地獄に疲れた開発者 | `package.json` に dependencies なし。Node.js 22.13+ の内蔵 SQLite（`node:sqlite`）とネイティブモジュールのみで構成（01 §2） | Pythonベースや重量級コンテナ（Docker/DevContainer）を前提とする基盤に対し、Node 22.13+ があれば即起動可能 | **4** | **5** | **危険**: 「古いNode環境でも動く」と誤解される。<br>**予防**: Node.js 22.13以上が必須である動作要件を明記。起動時間は実測約0.4秒（docs/install-walkthrough.md）。 |
| **9** | **Model-agnostic blackboard via standard MCP**<br>標準MCPで多様なクライアントが参加 | Claude、Codex、Antigravity等を状況に応じて使い分けたいユーザー | `src/hosts.mjs`, `src/tools.mjs`。標準MCP stdio中継（7ツール）を介し、異なるクライアントが同一プロジェクトで協調（01 §4） | 特定のLLM SDKに密結合したフレームワークと異なり、標準MCPツール呼び出しのみでモデル非依存に動作 | **4** | **4** | **訂正（D-5指摘2）**: 実証済みは Claude Code CLI、Claude Desktop の Code タブ、Codex CLI。チャット版 Claude Desktop は未検証であることを明記。 |
| **10** | **Peer review built into the loop**<br>相互レビューが組み込まれた品質管理 | AIが生成したコードの品質・ハルシネーションを懸念する開発者 | `src/core.mjs:1275-1312`。作成者以外のAIワーカーへの自動レビュータスク生成、差戻し（rework）サイクル、降格引き受け時のシニアレビュー義務化 | レビューを人間の目視や単一AIの自己反省に頼るツールが多い中、別エージェントによる検証をステートマシンとして強制（02 §4） | **4** | **5** | **危険**: 「バグが100%検出される」という過信。<br>**予防**: AI同士のレビューでも見落としは発生するため、最終マージ判断は人間が行う構造になっていることを説明。 |

---

## 2. リポジトリ情報と看板コピー（訂正版）

### 2.1 リポジトリ概要（GitHub About欄）
- **Description (英語・160文字以内)**:
  > Local, quota-aware multi-agent blackboard for Claude Code, Codex & Antigravity. Zero npm deps, git isolation (core ready), human-in-the-loop control.
- **Description (日本語参考)**:
  > Claude Code・Codex・Antigravityが協調するローカル黒板。npm依存ゼロ・gitワークツリー分離（中核実装済）・使用枠を考慮した自律タスク配分。
- **Topics (タグ)**:
  `mcp`, `multi-agent`, `claude-code`, `codex`, `antigravity`, `sqlite`, `git-worktree`, `developer-tools`, `local-first`, `autonomous-agents`

### 2.2 README冒頭看板コピー候補

#### 案A（機能・実利重視：推奨）
> **Turn idle subscriptions into working agents.**
> **Reset the chat. Not the progress.**
>
> IdleShift is a lightweight, local-first blackboard service that orchestrates your existing AI subscriptions (Claude Code, Codex, Antigravity) through standard MCP. Built and improved with itself.

#### 案B（安全性・開発者体験重視）
> **Collaborative AI agents that respect your repo and your limits.**
>
> Multiple AI agents work in parallel on dedicated git worktrees (core ready), report back to a single local SQLite blackboard, and pause when quota runs out. Human stays in control.

---

## 3. 実演デモ 3案（demos.md 整合版）

1. **デモ1: 「会話を捨てても仕事が続く（Reset the Chat）」**（推奨時間: 45秒）
   - **内容**: AI がタスクを途中まで進めて progress を報告（GUI に「Step1 完了」）。ウィンドウを閉じ、新しい会話で join して直前のタスクを受け取り Step2 から再開・完了する様子。
   - **注意点（D-5指摘7）**: `continuity.md` は条件付き（自動テスト実証済み）。引き継がれるのは黒板（SQLite）に書き出された要約・証拠・タスク状態のみであり、書き込みタスクの期限切れは人の確認を挟むことを明記。
2. **デモ2: 「2つのAIが互いのファイルを壊さずに並行作業（Git Isolation）」**（推奨時間: 60秒）
   - **内容**: Claude と Codex がそれぞれ `worktrees/PRJ-3/T-xxx` の専用ブランチで作業。メイン作業ツリーは一切汚れないことを `git status` で確認。
   - **注意点（D-5指摘3）**: マージ画面（B-3）は後続タスクであるため、中核分離動作のデモとし、マージは git コマンドまたは完成後の画面で行う注記を付与。
3. **デモ3: 「上限に達したAIを避けて、別のAIに回る（Quota Routing）」**（推奨時間: 60秒）
   - **内容**: ワーカーAが `report(kind=limit)` を送ると再開時刻まで提示が停止。待機していたワーカーBがそのタスクを引き継ぐ。
   - **注意点（D-5指摘1）**: 待機コストは未実証のため主張しない。上限報告後は preferGrace（約5分）の待機があるため、実演では早送り注記を入れる（demos.md 台本3と完全一致）。

---

## 4. ソーシャル・コミュニティ展開案（訂正版）

### 4.1 Hacker News（Show HN）タイトル 5案
1. `Show HN: IdleShift – Local multi-agent blackboard for Claude Code and Codex with zero npm deps`
2. `Show HN: Turn idle AI subscriptions into parallel agents using MCP and git worktrees`
3. `Show HN: An autonomous multi-agent blackboard that improved itself (181 passing tests, local SQLite)`
4. `Show HN: Reset the chat, not the progress – Multi-agent blackboard using standard MCP`
5. `Show HN: IdleShift – Local-first AI orchestrator that isolates writes in git worktrees`

### 4.2 X（英語投稿文）5案（訂正版）
1. **ローンチ告知**:
   > Excited to open-source IdleShift! 🚀
   > Turn your idle Claude Code / Codex / Antigravity subscriptions into cooperating agents.
   > 
   > 🔹 Standard MCP stdio
   > 🔹 Zero npm dependencies (Node 22 built-in SQLite)
   > 🔹 Git worktree isolation for every write task
   > 🔹 Reset the chat, not the progress
   > [Link to GitHub]
2. **自己改修の実績**:
   > Can AI agents really build software together?
   > We ran IdleShift on itself: 66 tasks, 62 accepted across 49.5 hours, with 33% rework rate caught by peer review.
   > 181 tests passing. Fully local SQLite state.
   > "Built and improved with itself."
   > [Link to GitHub]
3. **開発者のペイン訴求（Git破壊防止）**:
   > Running multiple AI coding agents usually results in overwritten files.
   > IdleShift isolates each write task in its own git worktree outside your repo.
   > Human verifies and merges. Always in control.
   > [Link to GitHub]
4. **枠の有効活用（Quota-aware routing）**:
   > Don't let your Claude Pro or ChatGPT Plus quota sit idle.
   > IdleShift pauses agents when limits hit and routes work to other models until reset.
   > Long-polling reduces idle polling overhead.
   > [Link to GitHub]
5. **アーキテクチャ解説（技術者向け）**:
   > Why we chose zero npm dependencies for IdleShift:
   > - Node.js 22.13+ `node:sqlite` (WAL mode, transactions)
   > - Standard named pipe / domain sockets
   > - Pure MCP stdio relays
   > No Docker, no Python venv, no 500MB node_modules. Clean and fast (startup ~0.4s).
   > [Link to GitHub]

---

## 5. 導入体験改善案（訂正版）

- **現状の登録方法（D-5指摘5）**:
  - `bin/idleshift.mjs` に存在するコマンドは `mcp`, `service`, `gui`, `stop`, `hosts`, `version` である（`setup` コマンドは未実装）。AIアプリの登録は GUI の「接続」画面または `hosts` コマンドから行う。
- **改善案（新設の提案として明記）**:
  1. `npx idleshift check` コマンドの新設提案: Node 22.13+、Git 2.38+、インストール済みAIアプリをワンショット診断。
  2. `npx idleshift setup` 対話型コマンドの新設提案: CLI から直接アプリ登録を行えるようにする機能拡充案。

---

## 6. 実証済み項目・調査項目・未実証項目の厳格区分（D-5指摘8対応）

1. **実機・コードで実証済み（Verified Facts）**:
   - `01-technical-audit.md`: npm依存ゼロ、Node内蔵SQLite、7つのMCPツール、Claude Code CLI / Claude Desktop Codeタブ / Codex CLI 接続。
   - `02-history.md`: PRJ-3 上で49.5時間稼働、66タスク中62件受理、33%レビュー差戻し。
   - `tests/git-isolation-core.test.mjs`: ワークツリー自動生成・並行分離・同名ブランチ拒否（全5件合格）。
   - `tests/evidence-quota-routing.test.mjs`: limit+reset_at 遮断、5h上限、stale回復（全件合格）。
   - `tests/evidence-continuity.test.mjs`: 同一ラベル再開、再起動永続化、リース切れ引き継ぎ（全件合格）。
2. **外部一次情報の読み取り調査（Market Research）**:
   - `03-competitors.md`: ConnectR, Chorus, Tutti, stringwork 等の一次情報（GitHub README, raw source, API）の読み取り。※IdleShift本体の機能実証とは区別。
3. **条件付き / 未実証（Conditional / Unverified）**:
   - 主張(a) 待機コスト: **未実証**（アプリ側タイムアウトにより毎時約11〜24回呼び出しが発生、トークン消費未実測）。
   - 主張(b) 使用枠配分: **条件付き**（自動テスト合格、実機3台の長時間録画は未取得）。
   - 主張(c) 継続性: **条件付き**（自動テスト合格、実アプリ間実機引き継ぎ録画は未取得）。
   - セキュリティ修正: S-1（AI文のhuman誤認）および S-5（停止ゴールひな形）は修正タスク進行中。
