# 空の環境からの導入 通し試験（A-4）

状態: 1回目（T-222、G-13、2026-11-12）。
方法: 一時フォルダーを `IDLESHIFT_HOME` にし、空の作業フォルダーを用意して、README の「ソースから」の手順どおりに CLI（`node bin/idleshift.mjs gui --print`）でサービスを起動。人の操作は GUI API で、AI の操作はアプリと同じく `bin/idleshift.mjs mcp` の中継を stdio で起動して MCP で行った。
本番のサービス・データ・AIアプリの設定ファイルには書き込んでいない（`hosts` は読み取りのみ）。
試験スクリプト: 作業用の一時スクリプト（リポジトリには入れていない）。手順は下の「通した流れ」のとおり。

## 結果の要約

起動 → プロジェクト作成 → フォルダー登録 → ゴール作成 → join → next → claim → plan → report → 完了候補 → 人の確定、まで **最後まで通った**。起動は約0.4秒、エラーなし、`stop` で停止し `service.json` も消えた。
ただし、利用者が詰まる・誤解する点が下のとおり見つかった。

## 見つかった問題（重い順）

### 1. 【高】AIアプリの登録に `IDLESHIFT_HOME` が焼き込まれ、データ置き場の変更（A-2）が効かなくなる

- `hosts.mjs:14` は、登録を実行したプロセスに `IDLESHIFT_HOME` があると、その値を AI アプリの MCP 設定の `env` に書き込む。
- このPCの実際の Claude Code の登録（`~/.claude.json`）には `"IDLESHIFT_HOME": "C:\\Users\\<ユーザー>\\AppData\\Local\\IdleShift"` が入っている（読み取りで確認）。
- 影響:
  - A-2 で既定を `%USERPROFILE%\.idleshift` に変えても、登録済みのアプリは古い場所を使い続け、.bat 側と再び分かれる。
  - MSIX のアプリでは、`%LOCALAPPDATA%` を指す値を明示しても振り替えは起きる（指定先自体が振り替え対象）。焼き込みは事故の防止にならない。
  - テスト用の一時 HOME で GUI を開いて「接続」から登録すると、本物のアプリが一時フォルダーを指してしまう。
- 修正案（A-2 に含める）: 既定の場所のときは `env` を書かない。登録画面で「既存の登録に IDLESHIFT_HOME が入っている」ことを検知して更新を促す（`up_to_date:false` の理由として表示）。

### 2. 【中】writes タスクを作れないときの案内が、正しい手段（ask_permission）と食い違う

- GUI API で委任範囲を指定せずに作ったゴールは、書き込みが許可されていない。進行役が `add_task(mode=writes)` を出すと、拒否文が「人の許可が必要なら ask_human を使ってください」と案内する（`core.mjs:676`）。
- 一方、join の guide と plan ツールの説明は「許可は ask_permission で求める。ask_human で許可を頼まない」と書いている。AI は矛盾した指示を受ける。
- 修正案（A-5 に含める）: 拒否文を「ask_permission {keys:["write_files"], reason} で人に求めてください」に直す。テストで文言を確認。

### 3. 【中】README の配布物の名前と、実際の dist が食い違う

- README は `dist\IdleShift-0.1.0-win-x64.zip` と `Install-IdleShift.cmd` を案内するが、`dist/` にあるのは改名前の `Conclavity-0.1.0-win-x64.zip`、`Install-Conclavity.cmd`。
- 古い配布物を入れると、改名前のデータ置き場・名前で動く可能性がある。
- 修正案: 古い dist を作り直す（`npm run dist`）か、少なくとも README に「dist は再生成が必要」と書く。古いものを消すのは人の判断。

### 4. 【中】書き込み許可が無いゴールでは、進行役が何もできずに繰り返し提示される

- 2で拒否された後、進行役が空の結果を返すと、すぐ次の進行役タスクが提示された（T-1 → T-2 → T-3）。設計どおり3回で人に戻るが、初めての利用者には「何も進まない」ように見える。
- GUI でゴールを作る画面の既定の委任範囲と、それが「AIにファイル変更をさせない」意味であることが一目でわかるかは、画面で確認していない（未確認）。
- 修正案: ゴール作成画面で書き込み許可の有無を目立たせる。進行役の assignment に「このゴールは書き込み不可」と明記する。

### 5. 【低】`IdleShift.bat` に、このPCだけの Node のパスが入っている

- `where node` に失敗すると `%LOCALAPPDATA%\Programs\nodejs\node-v24.22.1-win-x64\node.exe` を使う。他のPCでは存在しない。
- 失敗したときのメッセージが無く、`pause` で止まるだけ。
- 修正案: Node が見つからないとき「Node 22.13 以上を入れてください」と表示する。固定パスは G-17(E-1) の洗い出し対象として渡す。

### 6. 【低】README のデータ置き場の記述は A-2 の後に更新が必要

- README は「データは `%LOCALAPPDATA%\IdleShift`」と書いている。A-2 で変わったら README と `paths.mjs` 冒頭のコメントを直す。

### 問題でなかったもの

- `startPhrase` の作業フォルダーが「（このアプリで開いているフォルダー）」になったのは、試験スクリプトの引数の渡し方の誤りによるもので、IdleShift の不具合ではない。
- MCP の `initialize` は instructions を返し、ツールは7個（join, next, claim, get, report, plan, status）で README と一致。
- 完了候補は人の確定（`answerDecision confirm`）で `done` になった。

## 通した流れ（再現用）

1. `IDLESHIFT_HOME=<一時フォルダー>` を設定して `node bin/idleshift.mjs gui --print` → URL（`http://127.0.0.1:<port>/#t=<token>`）が出る。データ置き場に `idleshift.db`、`service.json`、`backups`、`exports`、`host-backups`、`logs` ができる。
2. GUI API: `createProject {name}` → `addRoot {project, path}` → `createGoal {project, goal:{title, outcome, done_evidence}}`。
3. `node bin/idleshift.mjs mcp` を同じ環境変数で起動し、MCP の `initialize` → `tools/list`。
4. `join {root, label}` → `next` → 進行役を `claim` → `plan` → `report`。
5. `propose_done` → GUI API の `answerDecision {decision, answer:"confirm"}` → ゴールが `done`。
6. `node bin/idleshift.mjs stop`。

## 修正タスク案（重い順）

| 順 | 内容 | 入れ先 |
|---|---|---|
| 1 | 登録に IDLESHIFT_HOME を焼き込まない／既存の焼き込みを検知して更新を促す | A-2（T-220） |
| 2 | not_delegated の拒否文を ask_permission に直す | A-5（T-223） |
| 3 | dist を新しい名前で作り直す、または README に注記 | A-5 か G-17 |
| 4 | ゴール作成画面で書き込み許可を目立たせる／進行役に書き込み不可を伝える | A-5 |
| 5 | .bat の Node 固定パスと、見つからないときの案内 | A-5、G-17(E-1) |
| 6 | README のデータ置き場の記述 | A-2 の後 |

## 次回

- A-2 の実装後に、同じ流れを .bat 起動と Claude デスクトップ起動の両方で行い、同じデータ置き場を使うことを確かめる（A-6 の範囲）。
- 配布物（zip）からの導入はこの回では試していない。
