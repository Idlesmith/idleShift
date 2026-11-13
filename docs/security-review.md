# セキュリティ点検結果（C-7 確定）

状態: 高1・中5の修正・レビュー完了（C-7、T-273、G-15、2026-11-13）。全修正は作業ツリーに反映済み（未コミット）。`npm test`: 200/200 pass（0 fail, 0 skipped）。
脅威モデル: [threat-model.md](threat-model.md)（観点の番号はこの表に対応）。

## 点検の記録

| 点検 | 担当 | 範囲（脅威モデルの観点） | 方法 |
|---|---|---|---|
| C-2（T-231） | P-6（claude-opus） | 1〜8: ローカルHTTP、パイプ、トークン、service.json、PowerShell、GUI | コードを読み、一時 HOME のサービスに試験スクリプトで実際に試した |
| C-3（T-232） | P-20 | 9〜12、19: 委任・予算の迂回、AI間の指示注入、なりすまし、人だけの操作、使用枠の浪費 | コードを読み、メモリ上の DB で再現 |
| C-4（T-233） | P-20 | 13〜18: パス判定、AIアプリ設定の書き換え、バックアップ/復元、ログ、adapters、配布物 | コードを読み、一時フォルダーで再現 |

- 本番のサービスとデータには、どの点検でも書き込んでいない。
- 修正は、点検した AI（P-6、P-20）以外が担当する（修正タスクで両者を除外）。
- 別の Windows ユーザー（攻撃者 A2）からの試験は、環境が無いため行っていない。

## 指摘の一覧（重い順）

| ID | 重大度 | 観点 | 内容 | 状態 | 修正・レビュー・テスト |
|---|---|---|---|---|---|
| S-1 | 高 | 10 | AI が `add_goal` で作ったゴールの文が、`from_human`・`notes_from_human` として、警告なしで別の AI に渡る。要約・証拠・handoff・結果の要約にも `untrusted_ai_*` の区別が無い | 修正済み | T-265（修正: P-5） / T-284（レビュー accept: P-6） / `tests/security-s1.test.mjs` / 未コミット |
| S-2 | 中 | 5 | 中継がサーバー側を確かめずに、同名パイプの持ち主へトークンを渡し、偽の応答を正規のツール結果として AI に渡す | 修正済み | T-266（修正: P-5） / T-298（レビュー accept: P-6） / `tests/security-s2.test.mjs` / 未コミット |
| S-3 | 中 | 4, 5 | 認証前のパイプに改行の無い巨大なデータを送ると、切断されずにメモリが増え続ける（320MB で +520MB） | 修正済み | T-267（修正: P-5） / T-299（レビュー accept: P-6） / `tests/security-s3.test.mjs` / 未コミット |
| S-4 | 中 | 11, 9 | 同じ接続から別の `label` で join し直すと、自分の成果を自分でレビューして受け入れられる | 修正済み | T-268（修正: P-5） / T-300（レビュー accept: P-6） / `tests/security-s4.test.mjs` / 未コミット |
| S-5 | 中 | 9, 19 | `add_goal` のひな形に停止・完了済みのゴールを使えるため、取り消された権限と予算を取り戻せる。作れるゴールの数に上限が無い | 修正済み | T-269（修正: P-5） / T-301（レビュー accept: P-6） / `tests/security-s5.test.mjs` / 未コミット |
| S-6 | 中 | 15 | `inspectBackup` が必須テーブルと整合性を確かめないため、不完全な DB で本番 DB を上書きした後に失敗しうる | 修正済み | T-270（修正: P-5） / T-302（レビュー accept: P-6） / `tests/security-s6.test.mjs` / 未コミット |
| L-1 | 低 | 14 | Claude Code の登録で `mcp remove` の後に `mcp add-json` が失敗すると、登録が消えたままになる | コード確認のみ（未再現） | 既知の制限 |
| L-2 | 低 | 6 | `IDLESHIFT_HOME` を `%TEMP%` の下にすると、継承された ACL で Codex のサンドボックス用グループが service.json（トークン）を読める。本番の場所では起きない | 確認済み（icacls） | 既知の制限 |
| L-3 | 低 | 1 | GUI のトークンは URL の断片で渡るので、起動時のコマンドラインとブラウザーの履歴に残りうる（同じユーザーのみ） | 未再現 | 既知の制限 |
| L-4 | 低 | 6 | `service.json` の `mode: 0o600` は Windows では効かない。保護はフォルダーの ACL に頼っている | コード確認 | 既知の制限 |

## 各指摘の詳細

### S-1【高】AI が書いたゴールの文が人の文として渡る
- 箇所: `src/core.mjs` の assignment（1210-1212 行付近）、`get("goal:…")`（1625 付近）、`addGoalsFrom`（1577-1578 付近）。関連: context の current_summary、next_step、recent_evidence、assignment.handoff、boardView の result。
- 再現: AI（P-1）が `add_goal` で notes などを書く → `get("goal:G-4")` で、それが `notes_from_human` として、`assignment().from_human` には警告なしで出てくる。
- 影響: 権限を持つ AI が書いた指示文が、別の AI には「人の指示」として届く。AI 間の指示注入の防御（untrusted 表示）の前提が崩れる。
- 修正案: `goals` に `author_kind`（human/ai）を加え、AI が作ったゴールの各文は `untrusted_ai_goal` として警告付きで返す。summary、evidence、handoff、result にも作成者の区別を付ける。
- 修正結果: 修正済み（T-265、担当 P-5、レビュー T-284 accept P-6、作業ツリー・未コミット）。v7 マイグレーションで `goals.author_kind`/`author` を追加し、AI 作成ゴールは `untrusted_ai_goal` に分離。`tests/security-s1.test.mjs`（3/3 pass）。

### S-2【中】パイプの先取りと偽サーバー
- 箇所: `src/relay.mjs` の `connectService` と hello。
- 再現: サービスを止め、同じパイプ名で偽のサーバーを開く → 中継を起動して tools/call → 偽サーバーが本物のトークンを受け取り、偽サーバーの文が `isError:false` のツール結果として AI に渡った。
- 影響: パイプ名はデータ置き場のパスのハッシュで、予測できる。同じユーザーの範囲では脅威モデルの対象外。別のユーザーがパイプ名を先に作れる場合は、トークンの取得と AI への指示注入になる（未再現）。
- 修正案: hello で中継が乱数を送り、サービスは `HMAC(token, 乱数)` を返す。中継は照合できなければ何も送らない。トークンそのものは送らず、中継側も `HMAC(token, サービスの乱数)` で証明する（相互認証）。外部ライブラリは不要（node:crypto）。
- 修正結果: 修正済み（T-266、担当 P-5、レビュー T-298 accept P-6、作業ツリー・未コミット）。`hello` / `hello_verify` による双方向 HMAC チャレンジレスポンスを実装し、平文トークン送信を廃止。`tests/security-s2.test.mjs`（2/2 pass）。

### S-3【中】認証前の巨大な行によるメモリ枯渇
- 箇所: `src/service.mjs` の pipe の readline（98-99 行付近）。長さの確認は、readline が改行までをため込んだ後に行われる。
- 修正案: `sock.on('data')` で、改行の無いバッファーの長さを数え、上限を超えたら即座に destroy する。認証前は hello の1行（例: 4KB）まで。
- 修正結果: 修正済み（T-267、担当 P-5、レビュー T-299 accept P-6、作業ツリー・未コミット）。`sock.on('data')` で改行なしのバイト数を監視し、認証前 4KB・認証後 2MB を超えた時点で即 `destroy()`。`tests/security-s3.test.mjs`（3/3 pass）。

### S-4【中】別名での再参加による自己レビュー
- 箇所: `src/core.mjs` の join（845-866 付近）、レビューの exclude（1311 付近）、plan の accept/rework（1486 付近）。
- 修正案: レビュー担当と受け入れ者の判定で、参加者 ID に加えて同じ接続（conn）と同じクライアントの名前・版も「同一」とみなす。少なくとも同じ接続からの別名の参加者は除外する。README の「名前単位の取消だけでは防げない」の記述とも整合させる。
- 修正結果: 修正済み（T-268、担当 P-5、レビュー T-300 accept P-6、作業ツリー・未コミット）。同一接続（`conn`）の別 `label` をレビュー提示・`claim`・`report` verdict・`plan` accept/rework から除外。`tests/security-s4.test.mjs`（2/2 pass）。※切断後に新しい接続＋別名で再参加する経路は既知の制限へ記載。

### S-5【中】停止・完了済みのゴールをひな形にした権限の取り戻し
- 箇所: `src/core.mjs` の plan（1408-1410 付近）、`addGoalsFrom`（1563-1583 付近）。
- 修正案: ひな形は `status='active'` のゴールに限る。プロジェクトごとに、AI が作れるゴールの数と、割当回数の合計に上限を設ける（超えたら人の判断）。
- 修正結果: 修正済み（T-269、担当 P-5、レビュー T-301 accept P-6、作業ツリー・未コミット）。ひな形を `status='active'` のみに制限し、プロジェクト全体の AI 作成ゴール数上限（既定 10）と割当合計上限（既定 300）超過時に `ai_goal_limit` の人間判断を起票。`tests/security-s5.test.mjs`（2/2 pass）。

### S-6【中】不完全なバックアップによる本番 DB の破損
- 箇所: `src/db.mjs` の `inspectBackup`（149-157 付近）、`src/service.mjs` の `restoreBackup`（195-197 付近）。
- 修正案: `inspectBackup` で `PRAGMA integrity_check` と、必須テーブルが全部あることを確かめる。復元は一時ファイルに開いて確かめてから置き換える（上書きの前に全部の確認を済ませる）。
- 修正結果: 修正済み（T-270、担当 P-5、レビュー T-302 accept P-6、作業ツリー・未コミット）。`inspectBackup` で `PRAGMA integrity_check` と版ごとの必須テーブルを確認し、`restoreBackup` は一時コピーを `openDb` で検証してから本番 DB を置き換え。`tests/security-s6.test.mjs`（2/2 pass）。

## 問題が無いと確認したもの

- HTTP: トークンが無い・誤り → 401。Host の偽装（DNSリバインディング）と、Origin が null・別のサイト → 403。フォームによる CSRF → 403。text/plain → 401。外部のアドレスからは接続できない（127.0.0.1 のみ）。CSP は `default-src 'none'`、`form-action 'none'`、`frame-ancestors 'none'`。Referrer-Policy は `no-referrer`。（C-2、再現）
- パイプ: 認証前の tool → 拒否。誤った hello の後の tool → 拒否。（C-2、再現）
- 本物のデータ置き場（`%LOCALAPPDATA%\IdleShift`）と `%USERPROFILE%` の ACL は、本人・SYSTEM・Administrators のみ。（C-2）
- GUI は Markdown を DOM で組み立て、リンクは文字のまま。innerHTML を使っていない。（C-2、コード）
- PowerShell のフォルダー選択は固定の文字列で、通知は base64 経由。（C-2、コード）
- 他プロジェクトの参照、ask_permission の選択肢の偽装、propose_done の確定は防がれている。（C-3）
- root の判定は realpath と isInside による。（C-3）
- adapters は全権限のフラグを使わず、起動回数の上限と待ち時間で暴走を抑えている。（C-3）
- AI アプリの設定の書き換えは、一時ファイルからの置き換えで、控えを取り、他の登録を壊さない（空白・日本語・引用符を含むパスで再現）。（C-4）
- 診断の出力は、ユーザーのフォルダーと長いトークン文字列を伏せている。（C-4）
- npm の依存は無い。（C-4）

## 既知の制限（公開時に SECURITY.md と README に書くこと）

- 同じ Windows ユーザーとして任意のコードを動かせる攻撃者からは守れない（データ置き場もトークンも読めるため）。
- 委任範囲は AI への「依頼」であり、AI がアプリの中で行う操作（ファイルの変更など）を IdleShift は止められない。
- 自己レビュー防止（S-4）の判定は現在の接続（`conn`）の同一性に基づく。担当者が切断して `conn` が NULL になった後に同じアプリが新しい接続と新しい名前で参加すると別人として扱われる（`client` 名と版まで同一視すると、同じアプリを使う別の人まで止めてしまうため。README の「名前単位の取消だけでは防げない」と同種の限界）。また、1つの接続を共有するアプリ（例: Antigravity の複数ウィンドウ）だけで運用するとレビューを引き受けられる参加者がいなくなるため、レビューを回すには別の接続または別アプリが必要。
- L-1〜L-4（上記一覧のとおり）。
