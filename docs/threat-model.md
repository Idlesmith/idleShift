# IdleShift 脅威モデル

状態: 初版（T-230、G-15）。コードを読んで書いた。ここに書いた「観察」はコードから読み取ったもので、実際に攻撃を試したものではない（試すのは C-2〜C-4）。
対象版: 作業ツリーの src/（2026-11-12 時点、コミット 1d4c944 ＋未コミットの A-3 作業）。

## 1. 構成のあらまし

| 部品 | ファイル | 役割 |
|---|---|---|
| サービス | src/service.mjs | 常駐。名前付きパイプとローカルHTTP(GUI)を開き、タイマーを回す |
| 中継 | src/relay.mjs, bin/idleshift.mjs | 各AIアプリが起動するMCPサーバー(stdio)。パイプ経由でサービスに中継し、無ければ起動する |
| 中核 | src/core.mjs, src/db.mjs | 黒板(SQLite)。委任範囲・予算・停止・担当の判定 |
| データ置き場 | src/paths.mjs | `%LOCALAPPDATA%\IdleShift`（G-13 で変更予定）。idleshift.db, service.json, backups, logs, host-backups, exports |
| AIアプリ設定 | src/hosts.mjs | Claude/Codex/Antigravity 等の設定ファイルへの登録・解除 |
| 起動アダプター | src/adapters.mjs | 人がONにしたときだけ、各社CLIを起動する（既定OFF） |
| GUI | gui/ | 127.0.0.1 で配信。トークンはURLの断片(#t=)で一度だけ渡す |

## 2. 守るもの（資産）

1. **ユーザーのファイル**: 登録した作業フォルダー(root)の中身と、その外のファイル。
2. **AIアプリの設定**: claude_desktop_config.json、Codex の config.toml など。壊れるとアプリが起動しない／別のMCPが消える。
3. **黒板のデータ**: idleshift.db（ゴール・委任範囲・予算・判断・証拠）、バックアップ、エクスポート。改ざんされると AI に渡る許可が変わる。
4. **サービスの秘密**: service.json のトークン。持っていればパイプ・GUI APIを人と同じ権限で操作できる。
5. **使用枠**: 各社サブスクの使用量。勝手な起動やループで浪費されると人の作業ができなくなる。
6. **人の判断権**: 許可の追加・完了の確定・停止は人だけができる、という約束そのもの。

## 3. 攻撃者の想定

| 記号 | 攻撃者 | できること（前提） |
|---|---|---|
| A1 | 同じPC・同じWindowsユーザーで動く別プロセス | ローカルのTCPに接続できる。同じユーザーのファイルは読める。 |
| A2 | 同じPCの別のWindowsユーザー（管理者でない） | ローカルのTCP・名前付きパイプに接続を試みられる。他人のプロファイルは読めない。 |
| A3 | ブラウザで開いた悪意あるWebページ | 127.0.0.1 へのリクエスト送信、DNSリバインディング、フォームによるCSRF。応答は読めない（CORS）。 |
| A4 | 悪意ある／乗っ取られたAI参加者 | MCPツール(join/next/claim/report/plan/get)を正規に呼べる。task 本文・report・evidence に任意の文章を書ける。 |
| A5 | 悪意あるリポジトリ内容 | 作業フォルダー内のファイル（README、設定、git hooks、名前）で AI やツールを誘導する。 |
| A6 | 悪意あるバックアップ／エクスポートファイル | 人が復元を選んだファイルの中身を自由に作れる。 |

### 対象外

- 管理者権限・SYSTEM 権限を持つ攻撃者、カーネルレベルの攻撃。
- 同じWindowsユーザーとして任意コードを実行できる攻撃者による **ファイルの直接改ざん**（A1 の完全な防御は不可能。ただし A1 が「ファイルを読めるがコードを動かせない」状況や、ブラウザ経由の A3 は対象）。
- 各社AIサービス・CLI 自体の脆弱性、AIアプリの権限設定の不備（IdleShift の外）。
- 物理的なアクセス、ネットワーク越しの攻撃（サービスはループバックのみで待ち受けるため。外部に公開されていたら設計違反として対象）。

## 4. 信頼境界

```
[ブラウザのWebページ] --(A3)--> | 127.0.0.1 HTTP (GUI API) | --+
[別ユーザー/別プロセス] --(A1,A2)-> | 名前付きパイプ           | --+--> [サービス/中核] --> [idleshift.db]
[AIアプリ]-(MCP stdio)->[中継]---> | 名前付きパイプ(トークン) | --+         |            --> [AIアプリ設定ファイル]
   ^ AIの文章(A4)が黒板を経由して別のAIに届く                              +--> [起動アダプター] --> [各社CLI] --> [作業フォルダー]
[作業フォルダーの中身](A5) ---> AI が読む / IdleShift がパスとして扱う
[バックアップ/復元ファイル](A6) ---> 復元処理
```

境界ごとの信頼の扱い:

- **B1 HTTP**: Host と Origin の一致、トークン(`x-idleshift-token`)、`application/json` のみ、サイズとレート制限（service.mjs:226-262）。
- **B2 パイプ**: 最初のメッセージでトークンを照合（service.mjs:103）。パイプ名はデータ置き場のハッシュ（paths.mjs:24）。
- **B3 service.json**: トークンの置き場。`mode: 0o600` で書くが、Windows では mode は ACL に効かない（観察。要確認）。データ置き場のACL（ユーザーのプロファイル配下）に頼っている。
- **B4 AI の文章**: AI が書いた題名・本文は `untrusted_ai_*` として返し、警告文を付ける（core.mjs:1016, 1198）。許可・予算・停止は中核が判定し、AI の申告では変わらない。
- **B5 AI アプリ設定**: 書き換え前にバックアップ（host-backups）、一時ファイルに書いてから置き換え（hosts.mjs:195-204）。
- **B6 CLI 起動**: 人がONにしたときだけ。Claude は `--permission-mode acceptEdits/default` と許可ツール一覧、Codex は `-s workspace-write/read-only`（adapters.mjs:37-50）。全権限フラグは使っていない（観察）。
- **B7 GUI 表示**: Markdown を DOM で組み立て、innerHTML を使わないと記述あり（gui/app.js:20。`innerHTML` の出現はこのコメント1か所のみ）。CSP あり。

## 5. 点検観点と担当の対応表

ゴールのメモにある観点を全部並べ、C-2〜C-4 のどれが調べるかを決める。○は主担当。

| # | 観点 | 主な場所 | 想定攻撃者 | 担当 |
|---|---|---|---|---|
| 1 | ローカルHTTP: トークンの渡し方（URL断片→sessionStorage）と保存 | gui/app.js:69-71, service.mjs:266 | A1, A3 | C-2 ○ |
| 2 | Origin/Host の検証、DNSリバインディング | service.mjs:230-234 | A3 | C-2 ○ |
| 3 | CSRF（フォーム送信、text/plain、プリフライト回避） | service.mjs:245-247 | A3 | C-2 ○ |
| 4 | 他のローカルプロセス・別ユーザーからの HTTP 呼び出し | service.mjs:263 | A1, A2 | C-2 ○ |
| 5 | 名前付きパイプの権限（既定ACL）と同名パイプの先取り・乗っ取り | service.mjs:91-134, relay.mjs:62-97 | A1, A2 | C-2 ○ |
| 6 | service.json の権限（Windows で 0o600 が効かない点）と他ユーザーからの読み取り | service.mjs:266, paths.mjs | A2 | C-2 ○ |
| 7 | フォルダー選択・通知の PowerShell 呼び出しへの注入 | service.mjs:30-60 | A3, A4 | C-2 ○ |
| 8 | GUI の DOM 組み立て（innerHTML 不使用）、CSP、AI の文章の表示 | gui/app.js, service.mjs CSP | A4 | C-2 ○ |
| 9 | 委任範囲と予算の迂回（add_goal、ask_permission、reassign、accept/rework、cancel、propose_done） | core.mjs plan 処理 | A4 | C-3 ○ |
| 10 | AI の文章による別AIへの指示注入（untrusted 表示の徹底、漏れている経路の有無: handoff、result_summary、evidence、summary、ask_human の文面） | core.mjs:1016, 1198, 1585, 1610 | A4 | C-3 ○ |
| 11 | 参加者のなりすまし（participant id の推測・再利用、label による再参加で他人の担当を取る） | core.mjs join/claim | A4 | C-3 ○ |
| 12 | 人だけが行う操作（判断への回答・完了の確定・停止）が AI から呼べないこと | core.mjs decisions | A4 | C-3 ○ |
| 13 | パス正規化と root 判定（大小文字、8.3短縮名、シンボリックリンク/ジャンクション、UNC、`..`） | paths.mjs:33-45 | A4, A5 | C-4 ○ |
| 14 | AI アプリ設定ファイルの書き換え（バックアップ、原子性、他エントリ不可侵、壊れた設定の扱い） | hosts.mjs | A1, A5 | C-4 ○ |
| 15 | バックアップ/復元/エクスポートの中身（秘密の混入、版の検証、復元時の不正値） | db.mjs:150-157, service.mjs:202-220 | A6 | C-4 ○ |
| 16 | ログへの秘密の混入（トークン、AI の文章、パス） | service.mjs log, adapters の logs/ | A1, A2 | C-4 ○ |
| 17 | adapters が CLI を起動する経路（exe の探し方、引数・stdin への注入、cwd、許可モード、一時設定ファイル） | adapters.mjs | A4, A5 | C-4 ○ |
| 18 | 配布物（dist/、.bat、restore-data.bat）が実行するもの | IdleShift.bat, restore-data.bat, scripts/build-dist.mjs | A5 | C-4 ○ |
| 19 | 使用枠の浪費（next の待機・起動アダプターの暴走・再提示ループ） | core.mjs next, adapters.mjs | A4 | C-3 ○ |
| 20 | G-14 で追加予定の git 操作（ワークツリー作成・マージ）への引数注入、悪意ある hooks | docs/git-isolation.md | A4, A5 | C-4（実装後に再点検） |

## 6. 主な脅威（STRIDE で整理）

点検の出発点となる仮説。事実ではない。

| 分類 | 脅威 | 主な観点 | 想定する深刻度 |
|---|---|---|---|
| なりすまし | 別プロセスが同名パイプを先に開き、中継からトークンを受け取る | 5 | 高（成立すれば全操作） |
| なりすまし | Webページが DNS リバインディングで GUI API を叩く | 2 | 高（Host 検証で防げているはず） |
| 改ざん | AI が plan で自分の委任範囲や予算を広げる | 9 | 高 |
| 改ざん | AI アプリ設定の書き換え途中の失敗で他のMCP登録が消える | 14 | 中 |
| 否認 | AI による操作がイベントに残らない | 9-12 | 低 |
| 情報漏えい | トークンがログ・エクスポート・バックアップ・URL履歴に残る | 1, 15, 16 | 中 |
| 情報漏えい | 別ユーザーが service.json を読める | 6 | 中 |
| サービス妨害 | 大量の task/report で DB が肥大、使用枠を浪費 | 19 | 中 |
| 権限昇格 | AI の文章が `untrusted_ai_*` を通らずに別AIへ届き、指示として実行される | 10 | 高 |
| 権限昇格 | PowerShell・CLI 引数への注入で任意コマンド実行 | 7, 17 | 高（成立すれば） |
| 権限昇格 | root 判定の抜けで登録外フォルダーのプロジェクトに参加 | 13 | 中 |

## 7. 点検の進め方（C-2〜C-4 への約束）

- 点検は read_only。再現はテスト用の別データフォルダー（`IDLESHIFT_HOME` を一時フォルダーに）で行い、本番のサービスやデータに触れない。
- 指摘ごとに: 観点番号、再現手順、実際の結果、深刻度（高/中/低）、修正案。憶測は「未再現」と明記する。
- 結果は C-5 が docs/security-review.md にまとめ、修正は点検者とは別のAIが行う。

## 8. 既知の前提と制限（現時点）

- 同じWindowsユーザーで任意コードを動かせる攻撃者からは守れない（データ置き場もトークンも読めるため）。
- AI アプリ側の権限設定（ファイル書き込みやコマンド実行の許可）は IdleShift の外。IdleShift の委任範囲は AI に「守るよう求める」もので、アプリ内の操作を止める力は無い（assignment にもそう明記されている）。
- 動作確認は Windows のみ。
