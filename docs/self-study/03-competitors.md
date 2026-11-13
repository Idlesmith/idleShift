# D-3 競合調査：一次情報に基づく比較表

調査日: 2026-11-12
担当: `P-20`（`agy-flash#2` / `antigravity-client`）
対象タスク: `T-237`（`G-16`）

## 0. 調査方針と確認範囲

- **他製品の実行・インストールは一切行っていない**（すべて GitHub 上の一次情報のみを参照）。
- **確認範囲**:
  - 全 9 製品について、GitHub リポジトリの `README.md` および GitHub REST API（`api.github.com/repos/...` によるスター数・ライセンス・最終更新日 `pushed_at`）を確認。
  - **ソースコードまで直接確認した範囲**:
    - **ConnectR**: `package.json`, `src/host.ts`, `src/spawn.ts`, `src/` ディレクトリ構成
    - **Chorus**: `cli.py`, `chorus_server.py`
    - **stringwork / umbel**: `internal/`・`src/` ディレクトリ構成
  - 上記以外の内部実装詳細は README 記載に基づくため、未確認の点は「README 記載なし / 未確認」と明記する。

---

## 1. 対象製品一覧と位置づけ（追加・整理）

ゴールのメモにある 9 製品すべてが、複数 AI コーディングエージェントの協調・オーケストレーションという競合／隣接領域に実在することを確認した。設計思想により大きく 4 類型に分かれる。

| 類型 | 製品 | リポジトリ URL | 概要 |
|---|---|---|---|
| **A. MCP 共有黒板・タスクボード型（会話側から取得／ハイブリッド）** | **IdleShift**（自社） | ローカル（未公開） | 7 つの MCP ツール＋ローカル常駐サービス＋Web GUI。会話側が `next(wait_seconds)` で取りに来る型（CLI 起動アダプターも任意・既定無効で存在） |
| | **ConnectR** | `https://github.com/JrKrishh/connectr` | MCP 共有ボード＋共有メモリ＋助言的ファイルロック＋CLI 自動起動（ハイブリッド型） |
| | **Marcus** | `https://github.com/painted-porch/marcus` | MCP ボード媒介協調（SQL リース＋依存関係）。Claude Code + tmux の Runner モードと MCP Attach モード |
| | **agent-tasks** | `https://github.com/keshrath/agent-tasks` | ステージゲート付き MCP パイプライン＋REST API＋Claude Code `/pipeline` ペイン |
| | **Befall** | `https://github.com/esenbora/befall-mcp` | MCP 経由の排他パスロック（先勝ち TTL）＋共有ボード。ローカルデーモンがホスト API（`befall.net`）と同期 |
| **B. MCP / CLI サブプロセス起動型（親が子 CLI を呼ぶ）** | **stringwork** | `https://github.com/jaakkos/stringwork` | Go 製単一バイナリの MCP サーバー。Driver（Cursor 等）がタスクを作り、サーバーが Worker CLI を自動起動 |
| | **Chorus** | `https://github.com/homilabo/Chorus` | 約 530 行の Python MCP サーバー。開いている CLI が指揮者となり、他 CLI をサブプロセスで呼ぶ |
| | **MCO** | `https://github.com/mco-org/mco` | CLI ファーストの並列オーケストレーター（12 種の CLI 対応）。MCP 黒板は持たない（並列レビュー・比較特化） |
| | **Umbel** | `https://github.com/jahala/umbel` | `tmux` 上で複数 CLI を遠隔操作（CLI / MCP / YAML ワークフロー）。macOS / Linux 専用 |
| **C. 統合デスクトップワークスペース型** | **Tutti** | `https://github.com/tutti-os/tutti` | macOS / Windows x64 対応のネイティブアプリ。既存エージェント＋内蔵アプリ＋共有コンテキスト（`@` 参照）。クラウド共有版 Tutti VM もあり |

---

## 2. 12 観点による一次情報比較表

### 表 2-1：課金・MCP・協調方式・継続性・導入・UI

| 製品 | 1. 既存サブスク利用 | 2. API従量課金必須か | 3. MCP 連携 | 4. タスク分散と自律取得 | 5. 会話履歴非依存の継続 | 6. 導入の簡単さ | 7. 既存 GUI/CLI そのまま利用 |
|---|---|---|---|---|---|---|---|
| **IdleShift** | **可**（Claude/Codex/Agy 等） | **不要** | **あり**（7 ツール、stdio 中継＋名前付きパイプ） | **あり**（`next` で提示→`claim`、優先・階層・依存管理） | **あり**（SQLite 黒板・証拠・要約・同ラベル再 `join`） | Win 向け配布 zip / `node`（Node 22.13+、npm 依存ゼロ） | **可**（アプリ/タブをそのまま使う。GUI は監視・判断用） |
| **ConnectR** | **可**（CLI/IDE 経由） | **不要** | **あり**（`board_view`, `ticket_claim`, `remember`, `claim_files` 等） | **あり**（MCP 自律 `ticket_claim`＋`connectr run` 自動配送） | **あり**（JSON ストアにチケット・教訓メモリを永続化） | `npm i -g connectr-mcp` → `connectr init` | **可**（IDE は MCP 参加、CLI は配送も可、TUI/Web UI あり） |
| **stringwork** | **可**（CLI 経由） | **不要** | **あり**（Driver/Worker 用 MCP ツール群） | **あり**（Driver が作成、Worker が自動起動後 `claim`） | **あり**（SQLite `~/.config/stringwork/state.sqlite`＋CLI session resume） | `install.sh` / `go build`（macOS/Linux 向け） | 一部（Driver は Cursor 等、Worker はサーバーが CLI 起動） |
| **Chorus** | **可**（CLI サブスク） | **不要** | **あり**（4 ツール: `ask`, `ask_all`, `parallel_ask`, `run_workflow`） | **なし**（指揮者 AI が同期的に `ask` で呼ぶ型） | **部分的**（プロセス内メモリ `_sessions` のみで永続DBなし、`cli.py:100`） | `git clone` + `./setup_mcp.sh`（Python 3.10+） | **可**（任意の CLI を指揮者として対話） |
| **Marcus** | Attach モードは可 | **Runner モードは API キー必要**（`.env` に `CLAUDE_API_KEY` 等、README 記載） | **あり**（任意 MCP エージェントが接続） | **あり**（SQL リーストランザクションで原子的に自律取得） | **あり**（カンバンボード＋アーティファクト永続化） | macOS/Linux/WSL2 + Python 3.11 + `tmux` + Docker(Planka/Postgres 等) | Attach は可（Runner は `tmux` で起動） |
| **agent-tasks** | **可**（Claude Code 等） | **不要** | **あり**（8 MCP ツール＋ローカル REST API） | **あり**（ステージゲート付きパイプラインで `claim`・親和性ルーティング） | **あり**（SQLite＋FTS5＋バージョン付きアーティファクト） | `npm i -g agent-tasks` または Claude Code プラグイン | **可**（Claude Code `/pipeline` ペインまたは他 MCP クライアント） |
| **Befall** | **可**（Claude/Codex/Cursor） | **不要**（ただし外部クラウド `befall.net` アカウント認証要） | **あり**（14 個の `vs_*` ツール） | **あり**（`vs_task_create` / `vs_task_claim` / `vs_handoff`） | **あり**（ホスト側ルームにタスク・ロック・メッセージを保存） | `npx befall login` → `init` → `up` | **可**（各 CLI/エディタから MCP 接続） |
| **MCO** | **可**（12 種の CLI 経由） | **不要** | **なし**（CLI ツール＋Skill。MCP 黒板は持たない） | **限定的**（並列/連鎖/ファイル分割配送のみ、自律取得なし） | **限定的**（単発実行・ファイル連鎖 `--chain`、永続ボードなし） | `npx @tt-a1i/mco@latest install` | 呼び出し元から CLI 実行（並列サブプロセス型） |
| **Umbel** | **可**（claude/codex/gemini） | **不要**（opencode のみ API 可） | **あり**（`umbel_spawn`, `umbel_send`, `umbel_wait`, `umbel_read` 等） | **限定的**（親 AI または YAML ワークフローが `spawn` 指示） | **部分的**（`~/.umbel/` にセッション記録＋`--resume`） | `bun install && bun run build` + `tmux>=3.0`（macOS/Linux のみ） | 親セッションはそのまま、子は `tmux` で起動 |
| **Tutti** | **可**（既存サブスククレジット対応） | **不要** | **あり**（Topics に `mcp` 記載） | **あり**（共有ワークスペース上で並列/直列タスク協調） | **あり**（会話・ファイル・成果物・タスクを統合保持） | macOS / Windows x64 インストーラー | **専用アプリ中心**（Tutti 内で各エージェントや内蔵アプリを使う） |

---

### 表 2-2：起動方式・権限・使用枠・人の承認・ライセンス・活動状況

| 製品 | 8. AI 起動方式と権限フラグ | 9. 使用枠（Quota）の考慮 | 10. 人の承認・統制 | 11. ライセンス | 12. 活動状況（2026-11-12 API 確認） |
|---|---|---|---|---|---|
| **IdleShift** | **会話側プル型が主**（`next` で取りに来る。既存 GUI/チャットタブの権限設定のまま動作）。CLI 起動機能もあるが既定無効、全権限フラグ不使用（`src/adapters.mjs`） | **あり**（`limit`＋`reset_at` 申告で再開時刻まで割当停止、ラベル別 5h/7d 件数・分上限、長待機 `next` 学習。ただし各社トークン残量は読めない） | **強い**（`delegation` 5 項目、予算上限、`decision_needed`、ゴール完了確定は人のみ） | 未設定（E ゴールで決定予定） | 開発中（2026-11-10〜11-12、ローカル稼働） |
| **ConnectR** | **ハイブリッド**（IDE は MCP 参加、CLI は `connectr run` で自動起動。`src/spawn.ts` に `PermissionMode` あり） | **部分的**（失敗 2 回で自動停止し「サプスクを浪費しない」と README 記載。5h/7d 上限や `reset_at` 管理は未確認） | **あり**（Web UI の `dispatch` 前に計画と権限モードを表示し人の確認を要求） | **MIT** | Stars **1** / Created 2026-08-26 / Pushed **2026-08-27** |
| **stringwork** | **サーバー起動型が主**（README 例で `claude -p ... --dangerously-skip-permissions` を Worker 起動に使用。カスタム MCP 参加も可） | **未確認**（README に使用枠・レート制限の記述なし。タイムアウト/ハートビート監視のみ） | 限定的（Driver 監視＋Web ダッシュボード。委任/承認ゲートは README 記載なし） | GitHub API 未取得（`LICENSE` 確認要） | Stars **0** / Created 2026-02-17 / Pushed **2026-11-10**（活発） |
| **Chorus** | **サーバー起動型**（`cli.py:118-186` で `claude --dangerously-skip-permissions`, `copilot --allow-all`, `codex --full-auto`, `gemini --sandbox false` を使用） | **なし**（`cli.py` にタイムアウトはあるが使用枠・再開時刻の考慮なし） | なし（指揮者チャット上で人が指示する形） | **MIT** | Stars **0** / Created 2026-03-24 / Pushed **2026-04-26** |
| **Marcus** | **両方**（Runner: Claude Code + `tmux` / Attach: MCP 接続。権限フラグ詳細は未確認） | **未確認**（README にリトライ負荷軽減・リース期限はあるが、サブスク使用枠管理の記述なし） | 限定的（Cato による可視化・監査ログが主） | **MIT** | Stars **17** / Created 2025-06-16 / Pushed **2026-11-11**（活発） |
| **agent-tasks** | **会話側参加型**（各エージェントが MCP 経由で接続） | **なし**（README に記載なし） | **未実装の注意点**（README に「スキーマに `require_approval` はあるが承認を記録する MCP/REST 経路がないため OFF にせよ」と明記） | **MIT** | Stars **23** / Created 2026-03-25 / Pushed **2026-10-24** |
| **Befall** | **会話側参加型**（各 CLI/IDE が MCP 接続。ただしクラウド `befall.net` 経由） | **なし**（README に記載なし。ロックの TTL 自動解放のみ） | なし（エージェント間の先勝ちロックとハンドオフが主） | **MIT** | Stars **0** / Created 2026-08-01 / Pushed **2026-09-16** |
| **MCO** | **CLI 起動型**（`read_only` / `write` / `yolo` の 3 モードを各 CLI のフラグへ変換、明示指定なしに `yolo` しない） | **なし**（README に使用枠考慮の記述なし） | **実行前確認**（呼び出し元エージェントが実行前にチーム構成をユーザーに確認する規約） | **MIT** | Stars **554** / Created 2026-02-26 / Pushed **2026-11-06**（活発） |
| **Umbel** | **サーバー/親起動型**（`tmux` で `claude`/`codex`/`gemini`/`opencode` を起動。`--allowedTools` 等を渡せる） | **なし**（README に使用枠考慮の記述なし） | なし（親エージェントまたは人が CLI/YAML で制御） | **MIT** | Stars **6** / Created 2026-05-21 / Pushed **2026-11-06**（活発） |
| **Tutti** | **ワークスペース統合型**（Tutti アプリ内で各エージェント・内蔵アプリを接続） | **部分的**（既存サブスククレジット利用を明記。レート制限ルーティング有無は未確認） | あり（人が同じリアルタイム空間で `@` 指示・共同編集） | **Apache-2.0** | Stars **3,910** / Created 2026-06-12 / Pushed **2026-10-08** |

---

## 3. 事実に基づく差別化ポイントと「固有の発明ではない」機能

### 3.1 他製品にもある機能（固有の発明として主張してはいけない点）
以下の機能はすでに複数の競合製品が実装しているため、IdleShift 独自の発明とはしない。
- **MCP による異種 AI（Claude / Codex / Gemini / Cursor 等）の共有黒板・タスクボード**: ConnectR、Marcus、agent-tasks、stringwork、Befall にもある。
- **会話履歴に依存しない状態永続化（SQLite / JSON ボード）とリース期限切れ再割当**: Marcus（SQL リース）、ConnectR（JSON ストア）、stringwork（SQLite＋ハートビート復旧）、agent-tasks（SQLite）にもある。
- **既存サブスクリプションの活用（API 従量課金不要）**: Chorus、ConnectR、stringwork、MCO、Umbel、Tutti すべてが対応（MCO・Umbel・Chorus・Tutti は明確に訴求）。

### 3.2 調査時点で確認できた IdleShift の実質的な差別化領域
1. **「会話側から取りに来る型」＋ 長時間待機（`next(wait_seconds)`）とクライアント別保留学習**:
   - Chorus・stringwork・MCO・Umbel のようにサーバーが `--dangerously-skip-permissions` 等で CLI サブプロセスを強制起動する型ではなく、**ユーザーが普段使っているデスクトップアプリや IDE チャットタブ（Claude Desktop の Code タブ、Antigravity、Codex 等）のまま参加**し、サーバー側が各クライアントの許容保留時間を学習しながら待機する構造は、比較対象 9 製品の中で明確に異なる（ConnectR の IDE 参加に近いが、IdleShift は `next(wait_seconds)` の長期保留学習と引き継ぎに特化している）。
2. **使用枠（`limit` / `reset_at`）と 5h/7d 上限のルーティング統合**:
   - 比較対象 9 製品のうち、エージェントからの `limit`＋`reset_at` 申告を受けて自動退避・再開試行し、さらにラベル別の 5 時間／7 日上限（件数・分）で割当を制御する仕組みを明示的に持つものは確認できなかった（ConnectR の「2 回失敗で停止」のみ部分的類似）。※ただし IdleShift も「各社のトークン残量を直接読む」のではなく「AI の自己申告と経過時間・件数カウント」による点（`E-414`）は必ず注記する必要がある。
3. **人による統制（委任 5 項目・予算・完了確定の分離）の徹底**:
   - agent-tasks は `require_approval` が未接続、Chorus・stringwork・Umbel は全権限フラグ前提または承認ゲートなしであるのに対し、IdleShift は権限・予算・完了確定を `Core` 側で強制している。
4. **Windows ネイティブ動作・依存ゼロ**:
   - Marcus・Umbel・stringwork（インストーラ）が macOS / Linux（または WSL2 + tmux）前提であるのに対し、IdleShift は Windows 上で Node.js（組み込み SQLite）のみ・外部 npm 依存ゼロで動作する。

### 3.3 逆に競合が先行している点（弱点・課題）
- **git worktree 分離とファイルロック**: ConnectR・stringwork・Umbel は git worktree 分離を実装済み、Befall・ConnectR・stringwork はパスロックを実装済み。IdleShift は `G-14` で設計中（未実装）。
- **クロスプラットフォーム対応と実績**: Tutti（Stars 3,910）や MCO（Stars 554）はすでに公開・コミュニティ実績があり、macOS / Linux でもそのまま動く。IdleShift は現時点で Windows 中心かつローカル開発中。
