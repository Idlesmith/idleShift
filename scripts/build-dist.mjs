// Builds a self-contained Windows package: the app, a bundled Node runtime and
// a double-click installer. Nothing is downloaded; the runtime is the Node
// that runs this script. Output: dist/IdleShift-<version>-win-x64.zip (+ .sha256)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { APP_ROOT, VERSION } from '../src/paths.mjs';

const name = `IdleShift-${VERSION}-win-x64`;
const dist = path.join(APP_ROOT, 'dist');
const out = path.join(dist, name);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'app'), { recursive: true });
fs.mkdirSync(path.join(out, 'runtime'), { recursive: true });

for (const d of ['bin', 'src', 'gui']) fs.cpSync(path.join(APP_ROOT, d), path.join(out, 'app', d), { recursive: true });
fs.copyFileSync(path.join(APP_ROOT, 'package.json'), path.join(out, 'app', 'package.json'));
fs.writeFileSync(path.join(out, 'app', 'build.json'), JSON.stringify({ version: VERSION, built_at: new Date().toISOString(), node: process.version }, null, 2));
fs.copyFileSync(process.execPath, path.join(out, 'runtime', 'node.exe'));
const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
if (fs.existsSync(nodeLicense)) fs.copyFileSync(nodeLicense, path.join(out, 'runtime', 'NODE-LICENSE.txt'));
else console.warn('注意: Node.js の LICENSE が見つかりません。配布前に runtime/NODE-LICENSE.txt を追加してください。');

const bom = text => '﻿' + text.replace(/\r?\n/g, '\r\n');
const ascii = text => text.replace(/\r?\n/g, '\r\n');

// Hidden launcher: no console window, starts the service if needed and opens the GUI.
fs.writeFileSync(path.join(out, 'app', 'IdleShift.vbs'), ascii(`Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run """" & base & "\\runtime\\node.exe"" --disable-warning=ExperimentalWarning """ & base & "\\app\\bin\\idleshift.mjs"" gui", 0, False
`));

// -NoShortcuts / -NoLaunch exist for automated tests of the installer itself.
fs.writeFileSync(path.join(out, 'install.ps1'), bom(`param([switch]$NoShortcuts, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dst = Join-Path $env:LOCALAPPDATA 'Programs\\IdleShift'
$data = Join-Path $env:USERPROFILE '.idleshift'
Write-Host 'IdleShift をインストールします。'
Write-Host "  インストール先: $dst"
Write-Host "  データの場所  : $data （更新しても残ります）"
$oldNode = Join-Path $dst 'runtime\\node.exe'
if (Test-Path $oldNode) {
  Write-Host '動作中の IdleShift を停止します…'
  try { & $oldNode (Join-Path $dst 'app\\bin\\idleshift.mjs') stop | Out-Null } catch {}
  Start-Sleep -Seconds 1
  $db = Join-Path $data 'idleshift.db'
  if (Test-Path $db) {
    $bk = Join-Path $data 'backups'
    New-Item -ItemType Directory -Force $bk | Out-Null
    Copy-Item $db (Join-Path $bk ("pre-update-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".db"))
    Write-Host '更新前のバックアップを保存しました。'
  }
}
New-Item -ItemType Directory -Force (Join-Path $dst 'runtime') | Out-Null
$newNode = Join-Path $src 'runtime\\node.exe'
$same = (Test-Path $oldNode) -and ((Get-FileHash $oldNode).Hash -eq (Get-FileHash $newNode).Hash)
if (-not $same) {
  try { Copy-Item $newNode $oldNode -Force }
  catch {
    Write-Host ''
    Write-Host 'AIアプリ（Claude / Codex / Antigravity など）が IdleShift を使用中のため更新できません。' -ForegroundColor Yellow
    Write-Host 'それらのアプリを一度終了してから、もう一度インストールを実行してください。'
    exit 1
  }
}
Get-ChildItem (Join-Path $src 'runtime') -Exclude 'node.exe' | Copy-Item -Destination (Join-Path $dst 'runtime') -Force
if (Test-Path (Join-Path $dst 'app')) { Remove-Item (Join-Path $dst 'app') -Recurse -Force }
Copy-Item (Join-Path $src 'app') $dst -Recurse -Force
Copy-Item (Join-Path $src 'uninstall.ps1') $dst -Force
$ws = New-Object -ComObject WScript.Shell
$dirs = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))
if ($NoShortcuts) { $dirs = @() }
foreach ($dir in $dirs) {
  $lnk = $ws.CreateShortcut((Join-Path $dir 'IdleShift.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $dst 'app\\IdleShift.vbs') + '"'
  $lnk.WorkingDirectory = $dst
  $lnk.Description = 'IdleShift'
  $lnk.Save()
}
Write-Host ''
Write-Host '完了しました。デスクトップまたはスタートメニューの「IdleShift」から起動できます。' -ForegroundColor Green
Write-Host 'AIアプリとの接続は、IdleShift の画面「接続」から行います（接続先は更新後もそのまま使えます）。'
if (-not $NoLaunch) { & (Join-Path $env:WINDIR 'System32\\wscript.exe') (Join-Path $dst 'app\\IdleShift.vbs') }
`));

fs.writeFileSync(path.join(out, 'uninstall.ps1'), bom(`$dst = Join-Path $env:LOCALAPPDATA 'Programs\\IdleShift'
$data = Join-Path $env:USERPROFILE '.idleshift'
$node = Join-Path $dst 'runtime\\node.exe'
if (Test-Path $node) { try { & $node (Join-Path $dst 'app\\bin\\idleshift.mjs') stop | Out-Null } catch {} ; Start-Sleep -Seconds 1 }
foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) { Remove-Item (Join-Path $dir 'IdleShift.lnk') -ErrorAction SilentlyContinue }
Set-Location $env:TEMP
Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'IdleShift を削除しました。'
Write-Host "データ（ゴール・履歴・バックアップ）は残しています: $data"
Write-Host '不要ならこのフォルダーを手動で削除してください。AIアプリ側の接続設定は、削除前に IdleShift の画面「接続」から外すか、各アプリのMCP設定から idleshift を削除してください。'
`));

const cmd = script => ascii(`@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0${script}"\r\necho.\r\npause\r\n`);
fs.writeFileSync(path.join(out, 'Install-IdleShift.cmd'), cmd('install.ps1'));
fs.writeFileSync(path.join(out, 'Uninstall-IdleShift.cmd'), cmd('uninstall.ps1'));

fs.writeFileSync(path.join(out, 'はじめに.txt'), bom(`IdleShift ${VERSION}

■ インストール
  1. このフォルダーを好きな場所に展開します。
  2.「Install-IdleShift.cmd」をダブルクリックします。
  3. デスクトップの「IdleShift」から起動します。

■ 使い方（3ステップ）
  1. 画面の「ホーム」でプロジェクトを作り、作業フォルダーを登録します。
  2.「接続」で、使いたいAIアプリ（Claude / Codex / Antigravity）に登録します。
     登録内容は事前に表示され、元の設定は控えを取ります。いつでも外せます。
  3. ゴールを書いて開始し、「接続」に表示される「開始の一言」をAIアプリに貼り付けます。

■ 更新
  新しい版の「Install-IdleShift.cmd」を実行するだけです。データと接続設定は引き継がれます。
  IdleShift は自動で更新を確認しません（外部と通信しないため）。配布元を時々確認してください。

■ 通信について
  IdleShift 本体はインターネット・LAN へ通信しません。AIサービスとの通信は各AIアプリが行います。
  参加したAIには、そのプロジェクトの内容が渡ります（＝そのAIの会社のサービスへ送られ得ます）。

■ 削除
  「Uninstall-IdleShift.cmd」を実行します。データは %USERPROFILE%\\.idleshift に残ります。

■ 同梱物
  runtime\\node.exe は Node.js（${process.version}）です。ライセンスは runtime\\NODE-LICENSE.txt を参照してください。
`));

const zip = path.join(dist, `${name}.zip`);
fs.rmSync(zip, { force: true });
const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${out.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`], { stdio: 'inherit' });
if (r.status !== 0) { console.error('zip の作成に失敗しました'); process.exit(1); }
const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(`${zip}.sha256`, `${sha}  ${name}.zip\n`);
console.log(`${zip}\n  ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB\n  sha256 ${sha}`);
