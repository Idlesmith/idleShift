# 01 技術監査：実際のアーキテクチャと機能の棚卸し（D-1）

担当: P-6（claude-opus）／T-235／2026-11-12
方法: ソースとテスト、README、docs を読んだ。このゴールではコード実行が許可されていないので、この監査のためにテストやプログラムは動かしていない。
ただし同じ日に、別のゴール（G-13）の作業で行った実行結果は、出典を書いたうえで引用している（★を付けた）。
対象: 作業ツリーの `src/`（コミット 1d4c944 ＋未コミットの変更。未コミット分には A-3 と A-5 の作業中の変更を含む）。

分類:
- **実装済み**: コードがあり、それを確かめるテストがある。
- **一部実装**: コードはあるが、テストが無い、または範囲が限られている。
- **構想段階**: 設計書だけで、コードは無い。
- **未検証**: コードはあるが、実際の環境（実アプリ・実機）では確かめていない。

## 1. 技術的な定義（一文）

IdleShift は、複数の AI アプリ（MCP クライアント）が共有する **ローカルの黒板サービス** である。各アプリが起動する stdio の MCP サーバー（中継）を通して、1つの常駐プロセスが持つ SQLite の状態にアクセスする。ゴール・タスク・担当・許可・予算は、AI ではなくこのサービスが判定する。

## 2. アーキテクチャ

| 部品 | 根拠 | 状態 |
|---|---|---|
| 中継（AIアプリが起動する MCP stdio サーバー。状態を持たず、DB を開かない） | `src/relay.mjs` `runRelay`、`bin/idleshift.mjs` の `mcp` | 実装済み（`tests/e2e.test.mjs`） |
| 常駐サービス（名前付きパイプ＋127.0.0.1 の GUI HTTP、タイマー） | `src/service.mjs` | 実装済み（e2e） |
| 中核（状態機械・権限・予算の唯一の判定者） | `src/core.mjs`（約1860行） | 実装済み（`tests/core.test.mjs` ほか多数） |
| 保存（SQLite、WAL、`BEGIN IMMEDIATE`、版ごとの移行。現在 v5） | `src/db.mjs:7,116,127` | 実装済み（`tier-usage-v4`、`project-archive-delete` の v5 移行テスト） |
| GUI（ブラウザーの窓。外部URLなし、CSP、innerHTML 不使用） | `gui/app.js:20`、`service.mjs:231` | 実装済み（e2e の CSP と外部URLの検査） |
| AI アプリへの登録 | `src/hosts.mjs`（Claude Code、Claude デスクトップ、Codex、Antigravity） | 一部実装（`hosts-toml-review11` は Codex の TOML のみ） |
| CLI 起動アダプター（既定は無効） | `src/adapters.mjs`（claude、codex、agy） | 一部実装／agy は未検証（コード内の表示名に「未検証」） |
| 依存ライブラリ | `package.json` に依存なし。Node 22.13 以上の内蔵 SQLite を使う | 実装済み |

MCP では標準のツール呼び出しだけを使い、sampling やサーバー発の通知などのオプション機能は使わない。ツールは7個（join、next、claim、get、report、plan、status）（README、`src/tools.mjs`）。★2026-11-12 の導入試験で `tools/list` が同じ7個を返した（docs/install-walkthrough.md）。

## 3. MCP・ファイル・SQLite の役割分担

- **SQLite（`idleshift.db`）が唯一の正本**。開くのはサービスだけ（README の構成図、`relay.mjs` 冒頭のコメント）。
- **MCP** は AI の入口。AI が書いた文章は `untrusted_ai_title` / `untrusted_ai_text` として、人が書いた内容とプログラムが保証する値から分けて渡す（`core.mjs:1016,1198,1585,1610`）。
- **ファイル**: `service.json`（pid・port・トークン）、`restore-watermark.json`（復元時に ID や世代が逆戻りしないための最大値。DB の外に置く。`service.mjs:180-189`）、backups、exports、host-backups、logs。
- 黒板の Markdown ファイルなどを利用者が管理する必要はない。既存の Markdown 黒板からの取り込みは未実装（README「未検証・残っている課題」）。

## 4. 対応している AI 環境

| 環境 | 登録 | 実際に接続できたか | 長時間の待機 |
|---|---|---|---|
| Claude Code CLI | 実装済み（`claude mcp add-json` を使う。`hosts.mjs:217-219`） | 実証（README の検証結果。2026-11-10、2.1.303） | 未実測 |
| Claude デスクトップの Code タブ | 上と同じ登録 | ★実証: この監査の担当自身がこの環境から join・claim・report を行っている（2026-11-12） | 待機の長さは未測定（提示が続いたため） |
| Claude デスクトップ（チャット） | 実装済み（JSON 設定） | 未検証（README） | 未検証 |
| Codex CLI | 実装済み（TOML） | 実証。ただし初回はツール呼び出しの承認で止まり、事前承認を設定した後に成功（README の検証結果。0.162.1） | 未実測 |
| Antigravity | 実装済み（JSON 設定） | 未検証（README）。ゴール G-13 の作業記録では、別の参加者が Antigravity から参加している可能性があるが、この監査では確認していない | 未検証 |
| Mac / Linux | — | 未対応（README） | — |

注意: ★MSIX 形式の Claude デスクトップから起動された中継とサービスは `%LOCALAPPDATA%` が振り替えられ、.bat 起動側とデータが分かれる不具合が 2026-11-12 に起きた（docs/data-home.md、G-13）。対策は設計済みで、実装はまだ（A-2）。

## 5. タスクの分割・割当・実行・完了判定

| 仕組み | 根拠 | 状態 |
|---|---|---|
| ゴール → タスク（role: research/design/implement/review/facilitate、mode: read_only/writes） | `core.mjs:24`、plan の `add_task` | 実装済み |
| 状態機械 open → offered(120秒) → claimed(30分、progress で延長) → reported → accepted | README「割当の状態機械」、`core.mjs` | 実装済み（core.test。同時 claim 20件で担当が1つ、と README に記載） |
| 世代番号（gen）で古い担当の報告を無効化。`report_id` で二重登録を防止 | `core.mjs`、`tests/report-id-review10.test.mjs` | 実装済み |
| 書き込みタスクの担当期限切れは自動で別担当に渡さず needs_check（人が判断） | README、`core.mjs:340` | 実装済み |
| 依存（depends_on）と、依存先が取消になったときの波及 | `core.mjs:618-650`、`tests/dependency-cancel-review9.test.mjs` | 実装済み |
| 仮説の枝（branch）と上限 | `tests/closed-branch-review8.test.mjs` | 実装済み |
| 進行役は常設ではなく「やることが無いとき」にプログラムが1件作る。新しい根拠なしで3回続くと人に戻す | README、`goals.facilitator_streak` | 実装済み。★2026-11-12 の導入試験で、書き込み許可の無いゴールでは進行役が空回りした（docs/install-walkthrough.md の4） |
| レビュー（review:true）は作成者以外が担当 | plan の `exclude`、`stale-review-review7` | 実装済み |
| 完了判定: AI は「完了候補」まで（propose_done）。人が確定 | `core.mjs:408,433-434` | 実装済み。★導入試験で `answerDecision confirm` により done になった |
| 委任範囲（write_files など）は人が設定。AI は ask_permission で求めるだけ。add_goal で作るゴールは元のゴールの範囲を継承し、狭めることしかできない | `core.mjs:676`、`tests/ai-goal.test.mjs`、`permission-decision.test.mjs` | 実装済み |
| 予算（割当回数、同時作業、枝、差戻し、無進展、期限） | README、`budgets` | 実装済み |

## 6. next の待機の実装

- `next(wait_seconds)` はサーバー側で応答を保留する。仕事が来れば保留中でもすぐ返す（`core.mjs:1067-1097`）。
- 保留の長さはアプリごとに学習する: 初回50秒、受理されたら倍、上限3600秒、途絶えた長さは24時間避ける（`core.mjs:37,783-789,1722-1724`）。途絶えた長さが24時間以内に記録されていれば、その8割を上限にする（`core.mjs:804`。README の記述と一致）。【訂正 2026-11-12: 初版では「8割の計算は見当たらない」と書いたが誤り。F-4 の作業で `holdFor` を読み直して確認した】
- 中継は進捗トークンがあれば20秒ごとに `notifications/progress` を送る（`relay.mjs`）。これに応じて待機時間を延ばすホストがある、とコメントにある（未検証）。
- 待機中に使用枠をどれだけ使うかは **未測定**（G-18 F-4 の対象。計画は docs/evidence/plan.md）。
- サービスが再起動すると待機中の呼び出しはエラーになり、最初の呼び出しは `rejoin_required` を返す。多くの AI はそこで止まり、人の一言が要る（docs/relay-reconnect.md。改善は構想段階）。

## 7. 会話履歴と作業状態の分離

- 作業状態（ゴール、要約、次の一手、タスク、報告、証拠、判断、handoff）はすべて DB にあり、会話には依存しない。
- 同じ `label` で `join` し直すと、担当中のタスクと世代が戻る（`join` の応答 `resumed`、`your_tasks`）。★この監査の担当自身、join で `resumed:true` を受け取っている（2026-11-12）。
- 残るのは黒板に書かれたものだけで、会話の中で考えて書かなかったことは残らない。
- 状態: 仕組みは実装済み。「会話を捨てて別の AI が引き継いで完了した」実例の記録は未確認（G-18 F-3 の対象）。

## 8. 競合制御・重複実行の防止・整合性・安全対策

| 項目 | 根拠 | 状態 |
|---|---|---|
| 書き込みはトランザクション（`BEGIN IMMEDIATE`）、WAL、busy_timeout 3000ms | `db.mjs:116,127` | 実装済み |
| 1つのタスクに有効な担当は1つ。同時 claim は1つだけ成功 | README の検証結果 | 実装済み |
| 版の検証（plan の `base_version`）。古い版の提案は全部拒否して最新の板を返す | plan の説明、`core.mjs` | 実装済み |
| 復元時の ID・世代の逆戻り防止（ハイウォーターマーク。壊れていたら復元を拒否） | `service.mjs:180-189`、`tests/restore-review6.test.mjs` | 実装済み |
| パイプはトークン認証。GUI は Host/Origin/トークン/JSON 限定/サイズとレート制限 | `service.mjs:91-134,226-263`、e2e | 実装済み |
| 参加の取消、アプリ単位の新規参加の拒否 | `tests/revoke-*.test.mjs`、`participant-cleanup` | 実装済み |
| 複数の AI が同じフォルダーに同時に書き込むことへの対策（git ワークツリーによる分離） | docs/git-isolation.md | **構想段階**（G-14） |
| 第三者によるセキュリティ点検 | docs/threat-model.md（観点20件） | 構想段階（G-15 で点検中。外部の監査は無い） |
| IdleShift 本体は外部と通信しない | README の「通信」 | 一部実装。コードに外部への通信は見当たらないが、プロセスツリー全体の無通信の検証は未実施（README） |
| AI のアプリ内の操作（ファイル変更など）は止められない。委任範囲は「依頼」 | assignment の文言、README | 設計上の限界（正直に表示している） |

## 9. 使用量とリセット時刻を考慮した配分

| 仕組み | 根拠 | 状態 |
|---|---|---|
| AI が report の `quota`（state、reset_at）や `kind=limit` で申告すると、そのアプリには reset_at まで提示しない（無ければ30分） | `core.mjs:376-399,1043,1323` | 実装済み（core のテスト） |
| reset_at を過ぎても「回復した証拠」とはせず、1回だけ試す | `core.mjs:395,1046-1047` | 実装済み |
| 人がラベルごとに5時間・7日の上限（引受け件数・作業分）を設定でき、超えると提示しない | `core.mjs:578-592`、`tests/tier-usage-v4.test.mjs` | 実装済み |
| 階層（planner/senior/worker）と降格時のレビュー必須 | `tests/tier-offer.test.mjs` ほか | 実装済み |
| 各社サービスの実際の使用量・トークン・課金額を読み取る | — | **無い**（設計として行わない。README の「計測の限界」）。IdleShift が数えるのは引受け件数と経過時間だけ |

宣伝で「使用枠を見て割り当てる」と書く場合は、「AI の申告と人が設定した上限に従う」意味であり、各社の使用量を自動で読み取るわけではないことを併記する必要がある。

## 10. 配布できるか・導入の障壁

| 項目 | 状態 |
|---|---|
| Windows 用 zip（Node の実行環境を同梱）とインストーラー（`scripts/build-dist.mjs`） | 一部実装。★`dist/` にあるのは改名前の `Conclavity-0.1.0-win-x64.zip` で、README の `IdleShift-0.1.0` とずれている（docs/install-walkthrough.md の3） |
| コード署名 | 無い（SmartScreen の警告が出る。README） |
| ソースからの導入 | ★2026-11-12、一時 HOME で起動から完了確定まで通った（docs/install-walkthrough.md） |
| 非開発者による通し試験 | 未実施（README の V10） |
| ライセンス | `package.json` は `UNLICENSED`、`private: true`。OSS として公開するには未決定（G-17） |
| 英語 | 画面・AI 向けの文面は日本語のみ（G-17 E-5/E-6 で計画中） |
| 導入の障壁（観察） | Node 22.13 以上が必要（ソースから）。AI アプリごとに MCP 登録と再起動が要る。Codex はツール呼び出しの事前承認の設定が要る。MSIX 版 Claude デスクトップでのデータ分裂（未修正）。AI アプリの登録に `IDLESHIFT_HOME` が書き込まれる問題（docs/install-walkthrough.md の1） |

## 11. 他製品と比べるときの注意（競合比較担当への申し送り）

- 「ローカルの MCP サーバーで複数 AI に共有の作業リストを持たせる」こと自体は、他製品にもある（ゴールのメモに挙がっている ConnectR、stringwork など）。これを IdleShift 固有の発明とは書けない。
- この監査から見て、IdleShift が比較で主張できそうな点（D-3 で他製品の一次情報と照らして確かめること）:
  1. AI を IdleShift 側から勝手に起動しない（アダプターは既定で無効、人が有効にしたときだけ。全権限のフラグは使わない。`adapters.mjs:37-50`）。
  2. 許可の追加・完了の確定・停止は人だけ。AI の申告では委任範囲や予算は変わらない。
  3. 保留つきの next と、アプリごとの保留時間の学習。
  4. AI の申告（quota/limit）と人の上限設定による割当の抑制。
  5. 世代番号、report_id、復元時のハイウォーターマークなどの整合性対策が、レビュー指摘とテストで裏付けられている。
- 反対に弱い点: Windows のみ、git による作業の分離が未実装、実アプリでの長時間待機と使用量は未測定、署名なし、日本語のみ。

## 12. 未確認のまま残した点（D-5 の相互検証で確かめてほしいこと）

1. （訂正済み）README の「途絶えた長さの8割」は `core.mjs:804` にあり、食い違いは無かった。
2. 自動テストの件数。README は「140件」と書くが、テストファイルは23本あり、件数は数えていない。★A-5 の作業（2026-11-12）でテストファイルを1本ずつ実行したとき、`relay-diagnostics.test.mjs`（作業中の未追跡ファイル）以外は成功した。
3. Antigravity からの実際の接続。
4. 外部と通信しないことの検証。
