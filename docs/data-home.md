# データ置き場の設計（A-1）

状態: 設計案（T-219、G-13）。実装は A-2（T-220）。
本番のデータフォルダーには書き込んでいない（読み取りのみ）。

## 1. 何が起きたか

- 現在の `dataHome()`（`src/paths.mjs:12-16`）は `IDLESHIFT_HOME` が無ければ `%LOCALAPPDATA%\IdleShift` を使う。
- Claude デスクトップはストア形式（MSIX）で入っており、その中から起動されたプロセス（MCP の中継、中継が起動したサービス）は、`%LOCALAPPDATA%` への書き込みが `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Local\` に振り替えられる。
- .bat から起動したサービスは本物の `%LOCALAPPDATA%\IdleShift` を使うので、データ・`service.json`・トークン・名前付きパイプ名（データ置き場のハッシュから作る、`paths.mjs:24`）が2組に分かれた。
- 2026-11-12 に実害があり、手作業で復旧済み。振り替え先には旧名のデータ `LocalCache\Local\Conclavity.bak-20261112\conclavity.db` が残っている（読み取りで確認）。

## 2. 実機で確かめたこと（2026-11-12、このPC）

Claude デスクトップの Code タブ（MSIX の中）から起動したシェルで、小さな試験ファイルを書いて確かめた（確認後に削除済み）。

| 書いた場所 | 結果 |
|---|---|
| `%LOCALAPPDATA%\isprobe-t219.txt` | **振り替えられた**。`%LOCALAPPDATA%\Packages\Claude_<パッケージID>\LocalCache\Local\isprobe-t219.txt` に実体ができた |
| `%USERPROFILE%\isprobe-t219.txt` | 振り替え先（`LocalCache` の下）には現れなかった。`LocalCache` の下には `Local`・`LocalLow`・`Roaming` しか無い |

- 同じ容器の中から見ているので「本物の `%USERPROFILE%` に書かれた」ことの最終確認は、容器の外（.bat 起動のプロセスやエクスプローラー）から行う必要がある。これは A-2 の実機確認の手順に入れる（下の 7）。
- `LocalCache\Roaming` もあるので、`%APPDATA%` も振り替えの対象と考えられる（未確認）。データ置き場の候補から外す。

### 一次情報

- Microsoft のドキュメント「Understanding how packaged desktop apps run on Windows」(learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-behind-the-scenes) によると、パッケージ化したデスクトップアプリの AppData への書き込みはパッケージごとの場所に振り替えられ、ユーザーのプロファイルの他の場所は振り替えられない。上の実機確認はこれと一致した。
  （URL は記憶による。A-2 の担当が開いて確認し、引用箇所を evidence に残すこと。）

## 3. 置き場の候補と比較

| 候補 | 振り替え | 他ユーザーから | 長所 | 短所 |
|---|---|---|---|---|
| `%LOCALAPPDATA%\IdleShift`（現行） | **される** | 読めない | Windows の作法どおり | 今回の事故の原因 |
| `%APPDATA%\IdleShift` | される（推定） | 読めない | — | 同じ問題。さらに移動プロファイルで同期されうる |
| **`%USERPROFILE%\.idleshift`** | されない（実機確認） | 読めない（プロファイルのACL） | 起動元に関係なく同じ場所。`~/.idleshift` で他OSとも揃う | ホームに隠しフォルダーが増える。OneDrive の「既知のフォルダー」移動の対象外なので同期はされない（利点） |
| `C:\ProgramData\IdleShift` | されない | **読める**（既定ACL） | — | トークンが他ユーザーに漏れる。不採用 |
| 環境変数 `IDLESHIFT_HOME` | 指定どおり | 指定次第 | テスト・上級者向け | 各AIアプリの設定に毎回書く必要がある。既定にはしない |

**採用: `%USERPROFILE%\.idleshift`**（`os.homedir()` を使う。`IDLESHIFT_HOME` があればそれを優先する現行の規則は残す）。

- 既定の場所は OneDrive などの同期フォルダーではない。`paths.mjs` 冒頭のコメントの方針（同期フォルダーを既定にしない）と一致する。
- `%USERPROFILE%` 自体が OneDrive の下に移されている特殊な構成は考えない（Windows の既知のフォルダー移動はデスクトップ・ドキュメント・ピクチャのみ）。

## 4. 新しい `dataHome()` の規則

```
1. IDLESHIFT_HOME があれば、それを使う（現行どおり）。
2. 無ければ <os.homedir()>\.idleshift を使う。
```

- `os.homedir()` は MSIX の中でも外でも `C:\Users\<name>` を返す（このPCで `USERPROFILE` は容器の中でも `C:\Users\<ユーザー>`）。
- パイプ名は新しい置き場のハッシュになるので、移行の後は容器の中と外で同じパイプ名になる。

## 5. 移行

### 移行元の候補（読み取って調べる場所）

- L1: 本物の `%LOCALAPPDATA%\IdleShift`
- L2: `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local\IdleShift`（Claude デスクトップの振り替え先。`Claude_*` は複数ありうる）
- L3: 旧名 `Conclavity` の同じ2か所（`...\Conclavity`、`...\LocalCache\Local\Conclavity*`）。旧名のデータは自動移行せず、見つけたことを警告するだけにする（改名時の手作業復旧で扱い済みのため）。

注意: 容器の中のプロセスから `%LOCALAPPDATA%\IdleShift` を読むと、L1 と L2 を重ねた見え方になる。そのため移行は **容器の外で動くプロセス（.bat、または `idleshift` のCLI）でだけ行う**。容器の中で起動したときは移行せず、警告だけ出す（6）。
容器の中かどうかは、`%LOCALAPPDATA%\Packages\<自分のパッケージ>` を判定する確実な手段が Node に無いため、次で判断する: 「`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local\IdleShift` が存在し、かつ L1 側で同名ファイルの更新時刻が食い違う」場合は判断できない → 人に聞く。判断できないときは移行しない。

### 判定

新しい置き場を N（`%USERPROFILE%\.idleshift`）とする。

| N | L1 | L2 | 動作 |
|---|---|---|---|
| ある | — | — | 何もしない（L1/L2 にデータが残っていれば 6 の警告だけ） |
| 無い | 無い | 無い | 新規作成 |
| 無い | ある | 無い | L1 を N へ移行 |
| 無い | 無い | ある | L2 を N へ移行 |
| 無い | ある | ある | **自動では統合しない**。両方の要約（ゴール数・最新イベント時刻・DBサイズ）を出して人に選ばせる。選ばれなかった方はそのまま残す |

### 手順（1か所から移行するとき）

1. サービスが動いていないことを確かめる（L1/L2 の `service.json` の pid が生きていれば中止し、「サービスを止めてから再実行」と表示する。止めるのは人の作業）。
2. 移行元の DB を SQLite のバックアップ API（既存のバックアップ処理と同じ方式）で N の一時ファイルに複写し、`PRAGMA integrity_check` が `ok` であることを確かめる。WAL（`-wal`/`-shm`）はバックアップ API が取り込むので個別に複写しない。
3. `backups`・`exports`・`host-backups`・`logs` を複写する。`service.json` は複写しない（新しいトークンで作り直す）。
4. 一時ファイルを `idleshift.db` に名前を変えて確定する。途中で失敗したら N を消して元のまま残す。
5. 移行元は **消さない**。移行元に `MOVED-TO-.idleshift.txt`（移行日時と移行先）を置く。これは移行元への唯一の書き込みで、本物の `%LOCALAPPDATA%\IdleShift` への変更になるので、移行を実行するのは人が起動したとき（.bat、または CLI の `idleshift migrate`）に限る。
6. イベントに `data_home_migrated`（移行元・移行先・DBサイズ）を記録する。

AIアプリの設定（`hosts.mjs` が書くMCP登録）は中継のコマンドを指すだけで、データ置き場のパスを含まないので書き換え不要（A-2 で確認すること）。

## 6. 起動時の検知と警告

サービスの起動時と GUI の表示時に、N 以外の場所（L1、L2、L3）に `idleshift.db`（または `conclavity.db`）があるかを調べる。

- N 以外にデータがあれば、GUI の上部に警告を出す:
  「別の場所にも IdleShift のデータがあります: <場所>（最終更新 <時刻>）。こちらのデータ（<N>）とは別のものです。移行済みなら移行元は削除してかまいません。」
- 移行元に `MOVED-TO-.idleshift.txt` があれば、警告の文言を「移行済みの古いデータ」に変える。
- 中継（relay）が認証に失敗したときのエラー文（A-3 の範囲）にも、データ置き場のパスと、他の場所にデータがあるかを含める。
- 警告は消せるが、該当のデータが消えるまで次の起動で再表示する。

## 7. A-2 で行う確認（完了の証拠(1)に対応）

自動テスト（`IDLESHIFT_HOME` を使わず、`os.homedir()` と `LOCALAPPDATA` を一時フォルダーに差し替えて）:

- `dataHome()` が `<home>\.idleshift` を返す。
- 移行の表の5通り。両方あるときに何も変えずに選択を求めること。
- 移行の途中失敗で N が残らず移行元も変わらないこと。
- 警告の検知（L1/L2/L3、移行済みの印あり/なし）。

実機手順（人またはAIが手で）:

1. 動作中のサービスを止める（人）。
2. .bat から起動 → `%USERPROFILE%\.idleshift\service.json` の pid と port を記録。
3. Claude デスクトップを再起動し、MCP から `join` → 応答の participant が同じ黒板のものであること、`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local\` に新しい IdleShift フォルダーができていないことを確認。
4. 逆順（Claude デスクトップから先に起動 → .bat）でも同じ `service.json` を使うことを確認。
5. エクスプローラー（容器の外）で `%USERPROFILE%\.idleshift` に実体があることを確認。

## 8. 人の作業

移行を安全かつ確実に行うための標準的な手順は以下のとおりです。

1. **動作中のサービスを停止する**
   - ターミナルまたは PowerShell で `IdleShift.bat restart` を実行するか、`node bin/idleshift.mjs stop` を実行して、旧データ置き場で動いている既存の IdleShift サービスを完全に停止します。
   - タスクマネージャー等でバックグラウンドに残っている node プロセス（旧サービス）がないことを確認します。

2. **`IdleShift.bat` から起動する（自動移行の実行）**
   - `IdleShift.bat` を開いて GUI を起動します。
   - 新しい既定のデータ置き場（`%USERPROFILE%\.idleshift`）に DB がなく、旧置き場（`%LOCALAPPDATA%\IdleShift`）にデータが存在する場合、起動時に自動で安全な移行（VACUUM INTO による WAL を含む DB 複製、整合性検証、`restore-watermark.json` の引き継ぎ、移行元の印 `MOVED-TO-.idleshift.txt` の書き込み）が実行されます。
   - ※ 本物の `%LOCALAPPDATA%\IdleShift` と Claude デスクトップの振り替え先（`Packages\Claude_*\LocalCache\Local\IdleShift`）の両方にデータが存在する場合は `choice_required` で起動が停止します。その場合は `node bin/idleshift.mjs migrate --source=l1`（本物の旧置き場）または `--source=l2`（振り替え先）を指定して手動で移行を実行してください。

3. **GUI の「接続」タブで各 AI アプリを再登録する**
   - GUI が開いたら「接続」タブを確認します。
   - 既存の設定ファイル（`claude_desktop_config.json` 等）に旧い `IDLESHIFT_HOME` が焼き込まれている場合、「旧い設定です」という案内が表示されます。
   - 各アプリの「登録」ボタンをクリックして再登録を行います。新しい登録では既定の置き場（`~/.idleshift`）を指すため、設定ファイルに `IDLESHIFT_HOME` は書き込まれず、常に正しい置き場を参照するようになります。

4. **各 AI アプリを再起動して作業を再開する**
   - Claude デスクトップ等の AI アプリを一度完全に終了し、再起動します。
   - S-2 で導入された相互 HMAC 認証の共通鍵（トークン）もサービス再起動に伴い新しくなるため、アプリ全体の再起動と再接続が必須となります。
   - AI アプリで `join` や開始の一言（再開フレーズ）を送り、正常に元の黒板・タスクが引き継がれていることを確認します。
   - ※ 万一、再登録前に旧い設定のまま AI アプリが中継を起動した場合でも、中継は旧い場所（`MOVED-TO-.idleshift.txt` がある場所）への接続を拒否し、「このアプリの登録が旧いデータ置き場を指しています。IdleShift の『接続』タブで再登録してください」という明確なエラーを返します。

5. **旧いデータフォルダーの確認と削除（任意）**
   - `%USERPROFILE%\.idleshift\idleshift.db` で作業が正常に進行していることを確認できたら、不要になった旧いフォルダー（`%LOCALAPPDATA%\IdleShift` や `Packages\Claude_*\LocalCache\Local\IdleShift`）は手動で削除してかまいません。

## 9. 残る不確実さ

- `%USERPROFILE%` 直下への書き込みが本物の場所に行くことは、容器の外からはまだ確認していない（7 の手順5）。
- 他の MSIX 形式の AI アプリ（Codex、Antigravity などがストア形式で配られた場合）も同じ振る舞いかは未確認。仕組みは同じなので同じ対策で足りると見込む。
- 一次情報の URL は記憶によるもの。A-2 で確認する。
