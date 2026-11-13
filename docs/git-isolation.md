# 作業ごとのgit分離（設計）

状態: 設計案（T-225）。レビュー待ち（T-254）。実装はまだない。
対象ゴール: G-14

## 目的と守ること

書き込みタスク（mode=writes）ごとに専用の git ワークツリーとブランチを用意し、担当AIはそこだけで作業する。複数のAIが同時に書き込んでも、互いのファイルや人の作業ツリーを上書きしない。

優先順位（ゴールの指定どおり）:

1. 人の作業ツリー（メインのチェックアウト）を IdleShift が勝手に変えない。
2. 取り込み（マージ）は人が画面で確定する。
3. 自動化はその次。

IdleShift は push・fetch・remote の操作を一切しない。外部ライブラリは使わず、`git` コマンドを `child_process.spawnSync`（引数は配列で渡し、シェルは通さない）で呼ぶ。

## 1. いつ作るか

- ワークツリーは、mode=writes のタスクが **claim されたとき** に作る。提示（offer）の時点では作らない。
- 作成に失敗したら claim を拒否し、タスクは `open` に戻す。失敗の理由（下の「拒否と理由」）は claim の応答と画面に出す。ワークツリーなしで作業させることはしない。
- read_only タスクと facilitator タスクは対象外。従来どおりメインの root で読む。
- 同じタスクが再割り当て（gen+1）されたときは、ワークツリーとブランチを作り直さずに **引き継ぐ**。前の担当がコミットした内容は残り、未コミットの変更も残る（未コミットがある場合は assignment で知らせる）。

## 2. 置き場とブランチ名

- 置き場はリポジトリの外、データフォルダーの下:
  `<dataHome>/worktrees/<project_id>/<task_id>`
  例: `%USERPROFILE%\.idleshift\worktrees\PRJ-3\T-226`（データフォルダーの場所は G-13 の決定に従う）。
  リポジトリの中に置かないので `.gitignore` は変えない。
- ブランチ名: `idleshift/<task_id>`（例: `idleshift/T-226`）。
  - 同名ブランチがすでにあり、IdleShift の記録（下の `worktrees` テーブル）に無いときは、人が作ったブランチとみなして触らず、claim を拒否して理由を出す。
- ワークツリーは `git worktree add -b idleshift/<task> <path> <base>` で作る。メインのチェックアウトの HEAD・index・作業ファイルは変わらない。

## 3. 起点コミット

- 既定の起点は、claim 時点の **メインの作業ツリーの HEAD のコミット**（`git rev-parse HEAD`）。起点のコミットIDは記録に残す。
- メインの作業ツリーに未コミットの変更があっても **拒否しない** し、その変更は持ち込まない。代わりに assignment に「人の未コミットの変更 N 件は起点に含まれていない」と書く。人の作業中の変更を勝手にコミットやスタッシュはしない。
- HEAD が無い（コミットが1つも無い）リポジトリでは分離できないので、素通し（9）と同じ扱いにして画面に理由を出す。
- detached HEAD でもコミットIDがあれば起点にできる。マージ先（7）は claim 時に記録したブランチ名を使い、detached のときはマージ先を人が画面で選ぶ。

## 4. assignment でAIに渡す情報

`assignment.program` に `workspace` を足す:

```json
"workspace": {
  "kind": "git_worktree",
  "path": "C:\\Users\\...\\.idleshift\\worktrees\\PRJ-3\\T-226",
  "branch": "idleshift/T-226",
  "base_commit": "1d4c944...",
  "target_branch": "main",
  "rules": [
    "ファイルの作成・変更はこのフォルダーの中だけで行う。元のフォルダーには書き込まない。",
    "report(kind=result) の前に、このブランチに変更をコミットする。push はしない。",
    "コミットされていない変更は、人がマージするときに取り込まれない。"
  ]
}
```

- 書き込みタスクの result を受け取ったとき、IdleShift は `git status --porcelain` でワークツリーを確かめる。未コミットの変更があれば result は受け取るが、記録に `uncommitted` の印を付け、レビュー担当と人に見えるようにする（自動ではコミットしない）。
- 起点からコミットが1つも無ければ「変更なし」と記録する。

## 5. 依存タスクが前段の成果を受け取る方法

方針は **「前段がマージ済みになるのを待つ」** を既定にする。

- depends_on の前段がすべて `accepted` で、かつ前段のブランチが人によってマージ済み（または破棄済み・変更なし）になるまで、後段の書き込みタスクは提示しない。こうすると後段の起点（メインの HEAD）に前段の成果が入っている。
- 前段が accepted でもマージ待ちのときは、画面の該当タスクに「前段のマージ待ち」と出す。
- 代わりの案（前段ブランチを起点にする連鎖）は、前段が後でやり直しになったときに後段の起点が古くなり、マージ順も複雑になるので、初版では採らない。将来ゴール設定で選べるようにする余地だけ残す。

## 6. レビュー担当が差分を読む方法

- review タスク（read_only）の assignment に、対象タスクの `branch`・`base_commit`・`path`（ワークツリーの場所）を渡す。
- レビュー担当は `git diff <base_commit>..idleshift/<task>` を読めばよい。assignment には変更ファイルの一覧と行数の要約（`git diff --stat`）も載せる。
- review タスクは読み取りのみなので、対象ワークツリーには書き込まない（rework の内容は report に書き、修正は元の担当または新しい担当が同じワークツリーで行う）。

## 7. 人によるマージ/破棄（画面とAPI）

画面（タスクの詳細）に次を出す:

- ブランチ名、起点、マージ先、コミット数、`git diff --stat` の要約、未コミットの印、競合の見込み。
- ボタン: 「マージ」「破棄」。どちらも確認つき。

API（ローカルHTTP、既存の認証に従う）:

- `POST /api/tasks/<id>/merge`
- `POST /api/tasks/<id>/discard`

マージの手順（すべて事前点検→実行。途中で失敗したら何も変えない）:

1. 対象タスクが `accepted` であること（未完了・取消済みはマージできない）。
2. メインの作業ツリーが **汚れていない** こと（`git status --porcelain` が空）。汚れていたら拒否して、変更のあるファイルを一覧で示す。
3. メインの作業ツリーの現在のブランチがマージ先と一致すること。違えば拒否して理由を示す（IdleShift がブランチを切り替えることはしない）。
4. 競合の事前点検: `git merge-tree --write-tree <target> idleshift/<task>`（git 2.38 以上）で競合が出ないことを確かめる。競合があれば拒否し、競合するファイルを示す。git が古くてこの点検ができないときは、マージを拒否して「git が古い」と理由を示す（作業ツリー上で試しにマージしてから戻す方式は、人の作業ツリーを変えるので採らない）。
5. 実行: fast-forward できれば `git merge --ff-only`、できなければ `git merge --no-ff -m "IdleShift: merge <task> <title>"`。
6. 実行が失敗したら `git merge --abort` で元に戻し、記録には失敗と git の出力を残す。

破棄:

- ワークツリーを削除（`git worktree remove --force`）し、ブランチを `git branch -D` で削除する。未マージのコミットがあることを確認画面に出す。
- 破棄はタスクの状態を変えない（accepted のまま、成果は採らなかった記録になる）。

## 8. 後始末と孤児の掃除

- マージ成功後: ワークツリーを削除し、ブランチを削除（`git branch -d`、マージ済みなので安全）。
- タスクが `cancelled` になったとき: ワークツリーとブランチは **すぐには消さない**。コミットがあれば成果が失われるので、画面に「破棄待ち」として残し、人が破棄を押したら消す。コミットが無く未コミットの変更も無ければ自動で消す。
- 起動時と1日1回の掃除:
  - `worktrees` テーブルにあるのにフォルダーが無い → 記録を `missing` にし、`git worktree prune` を実行。
  - フォルダーはあるのに記録が無い（`<dataHome>/worktrees` 以下） → 孤児として画面に一覧表示。自動では消さない（人が「削除」を押す）。
  - IdleShift の外で消されたブランチ → 記録を `missing` にする。
- 掃除は IdleShift が作ったもの（記録にあるもの、または置き場の下にあるもの）だけを対象にする。

## 9. git が無い・リポジトリでないとき

- root が git リポジトリでない、`git` が見つからない、ゴールで OFF になっている、のどれかなら **素通し**: 従来どおり root で作業させる。assignment の `workspace` は `{"kind": "shared_root", "path": "<root>", "reason": "..."}` とし、同時に書き込むと衝突しうることを rules に書く。
- 素通しの理由は画面のゴール欄にも出す。

## 10. ゴール設定と DB スキーマ（v6）

- ゴールの設定に `git_isolation`: `auto`（既定。git リポジトリなら ON）/`off` を足す。人だけが変えられる（AI の add_goal では `off` への変更のみ可、ON にはできない）。
- `SCHEMA_VERSION` を 6 に上げ、次を追加する:

```sql
ALTER TABLE goals ADD COLUMN git_isolation TEXT NOT NULL DEFAULT 'auto';
CREATE TABLE worktrees(
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repo_root TEXT NOT NULL,        -- メインの作業ツリーの場所
  path TEXT NOT NULL,             -- ワークツリーの場所
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  target_branch TEXT,             -- detached のときは NULL
  state TEXT NOT NULL,            -- active | merged | discarded | missing
  uncommitted INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
```

- 移行は既存の版上げの仕組み（db.mjs の版ごとの移行）に足す。既存の claimed 中の書き込みタスクには worktree を作らない（素通しのまま終わらせる）。
- バックアップ/復元に `worktrees` テーブルを含める。ワークツリーのフォルダー自体はバックアップしない（git のブランチに入っているため）。

## 11. Windows での注意

- 長いパス: 置き場のパスを短く保つ（`worktrees\<project>\<task>` だけ）。git には `-c core.longpaths=true` を付けて呼ぶ。
- ロック: エディターやウイルス対策がファイルを開いていると `git worktree remove` が失敗する。失敗したら記録を残して次回の掃除で再試行し、画面に「削除できなかった」と出す。
- 改行コード: ワークツリーはリポジトリの設定（`core.autocrlf`・`.gitattributes`）をそのまま使い、IdleShift は上書きしない。
- 大文字小文字: パスの比較は既存の `normalizeRoot` を使う。
- git の出力は `-c core.quotepath=false` と UTF-8 で読む。

## 拒否と理由（完了の証拠(4)に対応）

| 場面 | 動作 | 示す理由 |
|---|---|---|
| claim 時に同名ブランチが記録外で存在 | claim 拒否、open に戻す | ブランチ名と「人のブランチの可能性」 |
| claim 時に worktree 作成失敗 | claim 拒否 | git の出力 |
| マージ時にメインが汚れている | 拒否 | 変更のあるファイル一覧 |
| マージ時に現在のブランチがマージ先と違う | 拒否 | 現在のブランチとマージ先 |
| 競合の見込み | 拒否 | 競合するファイル一覧 |
| git が古く競合点検ができない | 拒否 | 必要な版（2.38 以上） |
| マージ実行の失敗 | abort して何も変えない | git の出力 |

## テスト計画（B-2/B-3 の実装時）

- 一時フォルダーに git リポジトリを作り、2つの書き込みタスクを同時に claim → それぞれ別のワークツリーで同じ名前のファイルを書き、互いに上書きしないこと・メインの作業ツリーが変わらないこと（完了の証拠(2)）。
- 汚れたメイン、ブランチ違い、競合、それぞれでマージが拒否され、メインの HEAD と作業ファイルが変わらないこと（(4)）。
- fast-forward と通常マージの両方。
- 取消・破棄・孤児・フォルダー消失の掃除。
- git でないフォルダーでの素通し。
- テストは `IDLESHIFT_HOME` を一時フォルダーに向け、本番のデータには触れない。

## やらないこと

- push、fetch、pull、remote の登録や変更。
- 人のブランチや未コミットの変更の自動コミット・スタッシュ・切り替え。
- リベースやスカッシュ。
- 前段ブランチを起点にした連鎖（将来の検討）。

## 参考

- 競合 ConnectR（JrKrishh/connectr）はチケットごとにワークツリーを作り、汚れたツリーではマージを拒否する方式と README に書かれている（未実行・README のみ確認）。本設計もこの2点は同じ方針。
