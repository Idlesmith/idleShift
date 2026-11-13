import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { dataHome, detectLegacyDataHomes, migrateDataHome } from '../src/paths.mjs';

function createDummyDb(filePath, goalsCount = 1) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);');
  db.exec("INSERT INTO meta(key, value) VALUES('schema_version', '6');");
  db.exec('CREATE TABLE goals(id TEXT PRIMARY KEY, title TEXT);');
  for (let i = 1; i <= goalsCount; i++) {
    db.exec(`INSERT INTO goals(id, title) VALUES('G-${i}', 'Goal ${i}');`);
  }
  db.close();
}

test('A-2: dataHome() returns ~/.idleshift when IDLESHIFT_HOME is not set', () => {
  const fakeHome = path.join(os.tmpdir(), 'fake-user-home');
  const env = { USERPROFILE: fakeHome, HOME: fakeHome };
  delete env.IDLESHIFT_HOME;
  assert.equal(dataHome(env), path.resolve(fakeHome, '.idleshift'));

  const explicit = path.join(os.tmpdir(), 'explicit-idleshift-home');
  assert.equal(dataHome({ IDLESHIFT_HOME: explicit }), path.resolve(explicit));
});

test('A-2: detectLegacyDataHomes finds L1, L2, L3 and checks MOVED stamp', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-detect-'));
  try {
    const fakeHome = path.join(tmp, 'user');
    const fakeLocal = path.join(tmp, 'localappdata');
    const env = { USERPROFILE: fakeHome, HOME: fakeHome, LOCALAPPDATA: fakeLocal };

    // Case: no legacy
    const d0 = detectLegacyDataHomes(env);
    assert.equal(d0.l1, null);
    assert.equal(d0.l2.length, 0);
    assert.equal(d0.l3.length, 0);

    // Case: L1 (%LOCALAPPDATA%\IdleShift) exists
    const l1Db = path.join(fakeLocal, 'IdleShift', 'idleshift.db');
    createDummyDb(l1Db, 2);

    // Case: L2 (%LOCALAPPDATA%\Packages\Claude_xyz\LocalCache\Local\IdleShift) exists
    const l2Db = path.join(fakeLocal, 'Packages', 'Claude_xyz', 'LocalCache', 'Local', 'IdleShift', 'idleshift.db');
    createDummyDb(l2Db, 3);

    // Case: L3 (Conclavity) exists
    const l3Db = path.join(fakeLocal, 'Conclavity', 'conclavity.db');
    createDummyDb(l3Db, 1);

    const d1 = detectLegacyDataHomes(env);
    assert.ok(d1.l1);
    assert.equal(d1.l1.dbPath, l1Db);
    assert.equal(d1.l1.isMigrated, false);
    assert.equal(d1.l2.length, 1);
    assert.equal(d1.l2[0].dbPath, l2Db);
    assert.equal(d1.l3.length, 1);
    assert.equal(d1.l3[0].dbPath, l3Db);

    // Add MOVED-TO-.idleshift.txt stamp to L1
    fs.writeFileSync(path.join(fakeLocal, 'IdleShift', 'MOVED-TO-.idleshift.txt'), 'migrated');
    const d2 = detectLegacyDataHomes(env);
    assert.equal(d2.l1.isMigrated, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-2: migrateDataHome handles 5 cases per docs/data-home.md', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-migrate-'));
  try {
    const fakeHome = path.join(tmp, 'user');
    const fakeLocal = path.join(tmp, 'localappdata');
    const env = { USERPROFILE: fakeHome, HOME: fakeHome, LOCALAPPDATA: fakeLocal };
    const targetDir = path.join(fakeHome, '.idleshift');

    // Case 1: Target N already exists with idleshift.db -> target_exists
    fs.mkdirSync(targetDir, { recursive: true });
    createDummyDb(path.join(targetDir, 'idleshift.db'), 1);
    const r1 = migrateDataHome(env);
    assert.equal(r1.status, 'target_exists');
    fs.rmSync(targetDir, { recursive: true, force: true });

    // Case 2: No N, No L1, No L2 -> fresh
    const r2 = migrateDataHome(env);
    assert.equal(r2.status, 'fresh');

    // Case 3: No N, L1 exists, No L2 -> migrates L1 to N
    const l1Dir = path.join(fakeLocal, 'IdleShift');
    const l1Db = path.join(l1Dir, 'idleshift.db');
    createDummyDb(l1Db, 5);
    fs.mkdirSync(path.join(l1Dir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(l1Dir, 'backups', 'dummy.txt'), 'backup content\n');

    const r3 = migrateDataHome(env);
    assert.equal(r3.status, 'migrated');
    assert.equal(r3.from, l1Dir);
    assert.equal(fs.existsSync(path.join(targetDir, 'idleshift.db')), true);
    assert.equal(fs.existsSync(path.join(l1Dir, 'MOVED-TO-.idleshift.txt')), true);
    assert.equal(fs.existsSync(l1Db), true); // source db is preserved, not deleted

    // Clean up N for next case
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(l1Dir, { recursive: true, force: true });

    // Case 4: No N, No L1, L2 exists -> migrates L2 to N
    const l2Dir = path.join(fakeLocal, 'Packages', 'Claude_testpkg', 'LocalCache', 'Local', 'IdleShift');
    const l2Db = path.join(l2Dir, 'idleshift.db');
    createDummyDb(l2Db, 7);
    const r4 = migrateDataHome(env);
    assert.equal(r4.status, 'migrated');
    assert.equal(r4.from, l2Dir);
    assert.equal(fs.existsSync(path.join(targetDir, 'idleshift.db')), true);
    assert.equal(fs.existsSync(path.join(l2Dir, 'MOVED-TO-.idleshift.txt')), true);

    // Clean up N for next case
    fs.rmSync(targetDir, { recursive: true, force: true });

    // Case 5: No N, Both L1 and L2 exist -> manual_choice_required (does not overwrite/combine)
    // Remove the MOVED stamp from l2 so both are active
    fs.rmSync(path.join(l2Dir, 'MOVED-TO-.idleshift.txt'), { force: true });
    createDummyDb(l1Db, 2);
    const r5 = migrateDataHome(env);
    assert.equal(r5.status, 'choice_required');
    assert.ok(r5.candidates.length >= 2);
    assert.equal(fs.existsSync(path.join(targetDir, 'idleshift.db')), false);

    // Case 5-b: Manual selection with select option
    const r5b = migrateDataHome(env, { select: 'l1' });
    assert.equal(r5b.status, 'migrated');
    assert.equal(r5b.from, l1Dir);
    assert.equal(fs.existsSync(path.join(targetDir, 'idleshift.db')), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-2: migrateDataHome includes uncheckpointed WAL rows and restore-watermark.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-wal-migrate-'));
  try {
    const fakeHome = path.join(tmp, 'user');
    const fakeLocal = path.join(tmp, 'localappdata');
    const env = { USERPROFILE: fakeHome, HOME: fakeHome, LOCALAPPDATA: fakeLocal };
    const targetDir = path.join(fakeHome, '.idleshift');

    const l1Dir = path.join(fakeLocal, 'IdleShift');
    fs.mkdirSync(l1Dir, { recursive: true });
    const l1DbPath = path.join(l1Dir, 'idleshift.db');

    // Create database in WAL mode and insert rows via child process that exits abruptly without db.close()
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(l1DbPath)});
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('CREATE TABLE items(id TEXT PRIMARY KEY, value TEXT);');
      db.exec("INSERT INTO items(id, value) VALUES('committed', 'initial');");
      db.exec("INSERT INTO items(id, value) VALUES('wal-only', 'uncheckpointed-data');");
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0);

    // Verify -wal exists
    const walFile = path.join(l1Dir, 'idleshift.db-wal');
    assert.ok(fs.existsSync(walFile), 'idleshift.db-wal should exist before migration');

    // Add restore-watermark.json and service.json in sourceDir
    fs.writeFileSync(path.join(l1Dir, 'restore-watermark.json'), JSON.stringify({ watermark: 42 }));
    fs.writeFileSync(path.join(l1Dir, 'service.json'), JSON.stringify({ pid: 99999, token: 'secret' }));

    // Execute migration
    const res = migrateDataHome(env);
    assert.equal(res.status, 'migrated');

    // Verify destination DB contains the uncheckpointed row
    const targetDbPath = path.join(targetDir, 'idleshift.db');
    assert.ok(fs.existsSync(targetDbPath));
    const targetDb = new DatabaseSync(targetDbPath);
    const row = targetDb.prepare("SELECT value FROM items WHERE id='wal-only'").get();
    targetDb.close();
    assert.equal(row?.value, 'uncheckpointed-data', 'WAL row must be included via VACUUM INTO in migrated database');

    // Verify restore-watermark.json is migrated
    assert.ok(fs.existsSync(path.join(targetDir, 'restore-watermark.json')));
    const wm = JSON.parse(fs.readFileSync(path.join(targetDir, 'restore-watermark.json'), 'utf8'));
    assert.equal(wm.watermark, 42);

    // Verify service.json is NOT copied
    assert.equal(fs.existsSync(path.join(targetDir, 'service.json')), false, 'service.json must not be copied');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-2: hosts relayCommand omits default IDLESHIFT_HOME and hostStatus reports outdated reason', async () => {
  const { relayCommand, hostStatus } = await import('../src/hosts.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-hosts-'));
  try {
    const fakeHome = path.join(tmp, 'user');
    const defaultDataHome = path.join(fakeHome, '.idleshift');

    // 1. Without IDLESHIFT_HOME -> no env in relayCommand
    const envDefault = { USERPROFILE: fakeHome, HOME: fakeHome };
    const cmd1 = relayCommand(envDefault);
    assert.equal(cmd1.env, undefined);

    // 2. With IDLESHIFT_HOME set to default location (~/.idleshift) -> no env in relayCommand
    const envExplicitDefault = { USERPROFILE: fakeHome, HOME: fakeHome, IDLESHIFT_HOME: defaultDataHome };
    const cmd2 = relayCommand(envExplicitDefault);
    assert.equal(cmd2.env, undefined);

    // 3. With IDLESHIFT_HOME set to custom location -> env is included
    const customHome = path.join(tmp, 'custom-data');
    const envCustom = { USERPROFILE: fakeHome, HOME: fakeHome, IDLESHIFT_HOME: customHome };
    const cmd3 = relayCommand(envCustom);
    assert.equal(cmd3.env?.IDLESHIFT_HOME, path.resolve(customHome));

    // 4. hostStatus reports reason when registration contains old IDLESHIFT_HOME
    const fakeRoaming = path.join(tmp, 'roaming');
    const desktopConfigFile = path.join(fakeRoaming, 'Claude', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(desktopConfigFile), { recursive: true });
    // Write old config containing IDLESHIFT_HOME
    fs.writeFileSync(desktopConfigFile, JSON.stringify({
      mcpServers: {
        idleshift: {
          command: process.execPath,
          args: ['idleshift.mjs', 'mcp'],
          env: { IDLESHIFT_HOME: path.join(tmp, 'old-localappdata', 'IdleShift') }
        }
      }
    }, null, 2));

    const envWithRoaming = { USERPROFILE: fakeHome, HOME: fakeHome, APPDATA: fakeRoaming };
    const status = hostStatus(envWithRoaming);
    const desktopStatus = status.find(s => s.key === 'claude-desktop');
    assert.ok(desktopStatus);
    assert.equal(desktopStatus.registered, true);
    assert.equal(desktopStatus.up_to_date, false);
    assert.match(desktopStatus.reason, /旧いデータ置き場/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-2: CLI migrate command executes migration and handles --source option', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-cli-migrate-'));
  try {
    const fakeHome = path.join(tmp, 'user');
    const fakeLocal = path.join(tmp, 'localappdata');
    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, LOCALAPPDATA: fakeLocal };
    delete env.IDLESHIFT_HOME;

    const binScript = path.resolve('bin', 'idleshift.mjs');

    // Create L1 data
    const l1Dir = path.join(fakeLocal, 'IdleShift');
    fs.mkdirSync(l1Dir, { recursive: true });
    createDummyDb(path.join(l1Dir, 'idleshift.db'), 3);

    // Run CLI: node bin/idleshift.mjs migrate
    const res1 = spawnSync(process.execPath, [binScript, 'migrate'], { env, encoding: 'utf8' });
    assert.equal(res1.status, 0);
    assert.match(res1.stdout, /移行しました/);
    assert.ok(fs.existsSync(path.join(fakeHome, '.idleshift', 'idleshift.db')));

    // Run again: already exists
    const res2 = spawnSync(process.execPath, [binScript, 'migrate'], { env, encoding: 'utf8' });
    assert.equal(res2.status, 0);
    assert.match(res2.stdout, /移行は不要です/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-2 (b): bin/idleshift refuses to start in migrated legacy directory (MOVED-TO-.idleshift.txt)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-moved-refusal-'));
  try {
    const movedDir = path.join(tmp, 'migrated-localappdata', 'IdleShift');
    fs.mkdirSync(movedDir, { recursive: true });
    fs.writeFileSync(path.join(movedDir, 'MOVED-TO-.idleshift.txt'), 'migrated to ~/.idleshift');

    const env = { ...process.env, IDLESHIFT_HOME: movedDir };
    const binScript = path.resolve('bin', 'idleshift.mjs');

    for (const cmd of ['gui', 'service', 'mcp']) {
      const res = spawnSync(process.execPath, [binScript, cmd], { env, encoding: 'utf8' });
      assert.equal(res.status, 1, `cmd ${cmd} should exit with 1`);
      assert.match(res.stderr, /このアプリの登録が旧いデータ置き場を指しています/);
      assert.match(res.stderr, /『接続』タブで再登録してください/);

      // Verify no idleshift.db or service.json was created
      assert.equal(fs.existsSync(path.join(movedDir, 'idleshift.db')), false, 'must not create idleshift.db');
      assert.equal(fs.existsSync(path.join(movedDir, 'service.json')), false, 'must not create service.json');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-2 (a): bin/idleshift service stops when legacy data exists without auto-migrating', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-service-no-automigrate-'));
  try {
    const fakeHome = path.join(tmp, 'user');
    const fakeLocal = path.join(tmp, 'localappdata');
    const l1Dir = path.join(fakeLocal, 'IdleShift');
    fs.mkdirSync(l1Dir, { recursive: true });
    createDummyDb(path.join(l1Dir, 'idleshift.db'), 2);

    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, LOCALAPPDATA: fakeLocal };
    delete env.IDLESHIFT_HOME;
    const binScript = path.resolve('bin', 'idleshift.mjs');

    const res = spawnSync(process.execPath, [binScript, 'service'], { env, encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /【移行が必要】旧データ置き場にデータが存在します/);
    assert.match(res.stderr, /IdleShift\.bat を開いて移行を実行してください/);

    // Verify ~/.idleshift/idleshift.db was NOT created by service
    assert.equal(fs.existsSync(path.join(fakeHome, '.idleshift', 'idleshift.db')), false);
    // Verify MOVED-TO was not created in l1Dir
    assert.equal(fs.existsSync(path.join(l1Dir, 'MOVED-TO-.idleshift.txt')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-2b: with explicit IDLESHIFT_HOME, bin/idleshift does not auto-migrate or write to LOCALAPPDATA', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-explicit-home-'));
  try {
    const fakeCustomHome = path.join(tmp, 'custom-home');
    const fakeLocal = path.join(tmp, 'localappdata');
    const l1Dir = path.join(fakeLocal, 'IdleShift');
    fs.mkdirSync(l1Dir, { recursive: true });
    createDummyDb(path.join(l1Dir, 'idleshift.db'), 5);

    const env = {
      ...process.env,
      IDLESHIFT_HOME: fakeCustomHome,
      LOCALAPPDATA: fakeLocal
    };
    const binScript = path.resolve('bin', 'idleshift.mjs');

    // Run 'gui --help' or a quick command like stop / check
    // If auto-migration ran, it would attempt to migrate l1Dir into fakeCustomHome and create MOVED-TO in l1Dir.
    // Testing with cmd='gui' but stopping quickly or checking that l1Dir is untouched:
    // To test safely without launching a full browser, we can spawn with an invalid sub-arg or verify service startup refusal check is skipped:
    // When IDLESHIFT_HOME is set, cmd='service' should NOT fail with '【移行が必要】' because auto-migration check is skipped!
    // Instead it will proceed to ensureRunning or service start.
    // Let's test that 'service' does NOT exit with status 1 '【移行が必要】':
    const res = spawnSync(process.execPath, [binScript, 'service', '--help'], { env, encoding: 'utf8', timeout: 5000 });
    // It should not output the legacy migration requirement error
    assert.doesNotMatch(res.stderr || '', /【移行が必要】/);
    assert.doesNotMatch(res.stdout || '', /旧データ置き場から新しい置き場/);

    // Verify L1 directory was NOT modified at all (no MOVED-TO stamp)
    assert.equal(fs.existsSync(path.join(l1Dir, 'MOVED-TO-.idleshift.txt')), false, 'L1 must not be stamped with MOVED-TO');

    // Also verify legacy_warnings in service API returns empty when IDLESHIFT_HOME is set
    const { runService } = await import('../src/service.mjs');
    const prevEnv = process.env.IDLESHIFT_HOME;
    process.env.IDLESHIFT_HOME = fakeCustomHome;
    let svc = null;
    try {
      svc = await runService({ home: fakeCustomHome, quiet: true, adaptersEnabled: false });
      const stateRes = await (await fetch(`http://127.0.0.1:${svc.port}/api/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-idleshift-token': svc.token },
        body: JSON.stringify({ method: 'state', params: {} }),
      })).json();
      assert.deepEqual(stateRes.result.legacy_warnings, [], 'legacy_warnings must be empty when IDLESHIFT_HOME is set');
    } finally {
      if (svc) {
        await svc.stop();
        // Give Windows a moment to release file locks on sqlite db/logs
        await new Promise(r => setTimeout(r, 100));
      }
      if (prevEnv !== undefined) process.env.IDLESHIFT_HOME = prevEnv;
      else delete process.env.IDLESHIFT_HOME;
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore Windows file locks in temp */ }
  }
});
