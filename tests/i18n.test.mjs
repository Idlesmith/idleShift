import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { t, DICTS, resolveUiLanguage, resolveAiLanguage } from '../src/i18n/index.mjs';
import { SCHEMA_VERSION } from '../src/db.mjs';

test('i18n: dictionary keys and signatures match across en and ja', () => {
  const enKeys = Object.keys(DICTS.en).sort();
  const jaKeys = Object.keys(DICTS.ja).sort();
  assert.deepEqual(enKeys, jaKeys, 'en and ja must contain the exact same keys');

  for (const k of enKeys) {
    const enVal = DICTS.en[k];
    const jaVal = DICTS.ja[k];
    assert.equal(typeof enVal, typeof jaVal, `Key ${k} must have identical type in en and ja`);
    if (typeof enVal === 'function') {
      assert.equal(enVal.length, jaVal.length, `Function ${k} parameter count must match in en and ja`);
    }
  }
});

test('i18n: t() falls back gracefully and handles arguments', () => {
  assert.equal(t('en', 'refusal.stale_generation', 1, 2), 'Generation mismatch (yours: 1, current: 2).');
  assert.equal(t('ja', 'refusal.stale_generation', 1, 2), '世代が違います（あなた: 1、現在: 2）。');
  assert.equal(t('fr', 'refusal.unknown_project'), 'Project not found.');
  assert.equal(t('en', 'nonexistent.key'), 'nonexistent.key');
});

test('i18n: resolveUiLanguage and resolveAiLanguage', () => {
  assert.equal(resolveUiLanguage('en'), 'en');
  assert.equal(resolveUiLanguage('ja'), 'ja');
  assert.equal(['en', 'ja'].includes(resolveUiLanguage('auto')), true);
  const saved = process.env.IDLESHIFT_UI_LANGUAGE;
  try {
    process.env.IDLESHIFT_UI_LANGUAGE = 'en';
    assert.equal(resolveUiLanguage('auto'), 'en', 'IDLESHIFT_UI_LANGUAGE pins auto');
    process.env.IDLESHIFT_UI_LANGUAGE = 'ja';
    assert.equal(resolveUiLanguage('auto'), 'ja');
    assert.equal(resolveUiLanguage('en'), 'en', 'an explicit setting still wins');
  } finally {
    if (saved === undefined) delete process.env.IDLESHIFT_UI_LANGUAGE; else process.env.IDLESHIFT_UI_LANGUAGE = saved;
  }

  assert.equal(resolveAiLanguage('en', 'ja'), 'en');
  assert.equal(resolveAiLanguage('ja', 'en'), 'ja');
  assert.equal(resolveAiLanguage('ui', 'ja'), 'ja');
  assert.equal(resolveAiLanguage('ui', 'en'), 'en');
  assert.equal(resolveAiLanguage('other', 'ja'), 'en');
});

import { makeCore, seed, joinAs, tmpDir } from './helpers.mjs';
import { runService } from '../src/service.mjs';

const HAS_JP = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;

test('i18n: ai_language=en produces zero Japanese in join -> next -> claim and refusals', async () => {
  const { core } = makeCore();
  const { project, root, goal } = seed(core);
  // Seed uses Japanese project/goal titles by default; replace with English so we can assert the whole payload has zero JP.
  core.run("UPDATE projects SET name='Test project' WHERE id=?", project);
  core.run("UPDATE goals SET title='Test goal', outcome='Done', done_evidence='Tests pass' WHERE id=?", goal);
  core.setLanguages({ ai_language: 'en', ui_language: 'en' });

  const joined = core.join({ root, label: 'worker-en', client: 'test-app', client_version: '1.0' }, { conn: 'c-en' });
  assert.equal(HAS_JP.test(JSON.stringify(joined)), false, `join must not contain Japanese: ${JSON.stringify(joined)}`);

  const offered = await core.next({ participant: joined.participant });
  assert.equal(offered.kind, 'offer');
  assert.equal(HAS_JP.test(JSON.stringify(offered)), false, `next offer must not contain Japanese: ${JSON.stringify(offered)}`);

  const claimed = core.claim({ participant: joined.participant, task: offered.task, gen: offered.gen });
  assert.equal(HAS_JP.test(JSON.stringify(claimed)), false, `claim assignment must not contain Japanese: ${JSON.stringify(claimed)}`);

  assert.throws(() => core.plan({ participant: joined.participant, goal, base_version: 999, ops: [{ op: 'add_task', title: 'x' }] }), e => {
    assert.equal(e.code, 'stale_plan');
    assert.equal(HAS_JP.test(e.message), false, `Refusal must be English: ${e.message}`);
    return true;
  });

  // Switching to ja restores Japanese AI-facing text
  core.setLanguages({ ai_language: 'ja' });
  const joinedJa = core.join({ root, label: 'worker-ja', client: 'test-app', client_version: '1.0' }, { conn: 'c-ja' });
  assert.equal(HAS_JP.test(joinedJa.guide), true, 'ai_language=ja must return Japanese guide');
});

test('i18n: GUI API setLanguages persists ai_language and ui_language in state snapshot', async () => {
  const home = tmpDir('i18n-gui');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  const gui = async (method, params) => (await (await fetch(`http://127.0.0.1:${svc.port}/api/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-idleshift-token': svc.token },
    body: JSON.stringify({ method, params }),
  })).json());
  try {
    const initial = (await gui('state', {})).result.settings;
    assert.equal(initial.ai_language, 'en');
    assert.equal(initial.ui_language, 'auto');

    const updated = await gui('setLanguages', { ui_language: 'ja', ai_language: 'ui' });
    assert.equal(updated.ok, true);
    assert.equal(updated.result.ui_language, 'ja');
    assert.equal(updated.result.ai_language, 'ui');
    assert.equal(updated.result.effective_ai_language, 'ja');

    const bad = await gui('setLanguages', { ai_language: 'fr' });
    assert.equal(bad.ok, false);
  } finally {
    await svc.stop();
  }
});

function loadGuiDicts() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve('gui/i18n/en.js'), 'utf8'), ctx);
  vm.runInNewContext(fs.readFileSync(path.resolve('gui/i18n/ja.js'), 'utf8'), ctx);
  return ctx.window.GUI_I18N;
}

test('i18n: GUI dictionaries match across en and ja, and all gt() keys in gui/app.js exist', () => {
  const dicts = loadGuiDicts();
  const enKeys = Object.keys(dicts.en).sort();
  const jaKeys = Object.keys(dicts.ja).sort();
  assert.deepEqual(enKeys, jaKeys, 'gui/i18n/en.js and ja.js must contain the exact same keys');

  for (const k of enKeys) {
    assert.equal(typeof dicts.en[k], typeof dicts.ja[k], `GUI key ${k} type mismatch`);
    if (typeof dicts.en[k] === 'function') {
      assert.equal(dicts.en[k].length, dicts.ja[k].length, `GUI function ${k} arity mismatch`);
    }
  }

  const appSrc = fs.readFileSync(path.resolve('gui/app.js'), 'utf8');
  const staticKeys = [...appSrc.matchAll(/\bgt\(\s*'([^']+)'\s*[,)]/g)].map(m => m[1]);
  assert.ok(staticKeys.length > 50, 'Expected gt() calls in gui/app.js');
  for (const k of staticKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(dicts.en, k), `Missing key ${k} in gui/i18n/en.js`);
    assert.ok(Object.prototype.hasOwnProperty.call(dicts.ja, k), `Missing key ${k} in gui/i18n/ja.js`);
  }
});

test('i18n: decisions format dynamically by ui_language, preserve legacy rows, and v7->v8 migrates cleanly', () => {
  const { core } = makeCore();
  const { project, root, goal } = seed(core);
  const { participant } = core.join({ root, label: 'dec-tester', client: 'test-app', client_version: '1.0' }, { conn: 'c-dec' });
  core.setLanguages({ ui_language: 'en' });
  const decId = core.raiseDecision({
    project,
    goal,
    kind: 'no_progress',
    askedBy: 'system',
    messageKey: 'decision.no_progress',
    messageArgs: [3],
    options: ['continue', 'stop'],
  });

  // Legacy row (message_key IS NULL)
  const legacyId = 'D-LEGACY';
  core.run(
    "INSERT INTO decisions(id,project_id,goal_id,task_id,kind,question,message_key,message_args,options,state,asked_by,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,?)",
    legacyId, project, goal, null, 'question', 'Legacy custom question text', '["confirm"]', 'pending', 'P-1', Date.now()
  );

  let snapEn = core.snapshot();
  const dEn = snapEn.decisions.find(d => d.id === decId);
  assert.equal(HAS_JP.test(dEn.question), false, `en decision must not have JP: ${dEn.question}`);
  assert.ok(dEn.question.includes('3'));
  assert.equal(snapEn.decisions.find(d => d.id === legacyId).question, 'Legacy custom question text');

  core.setLanguages({ ui_language: 'ja' });
  const snapJa = core.snapshot();
  const dJa = snapJa.decisions.find(d => d.id === decId);
  assert.equal(HAS_JP.test(dJa.question), true, `ja decision must be Japanese: ${dJa.question}`);
  assert.ok(dJa.question.includes('3'));

  const gotEn = core.get({ participant, ref: 'decisions' });
  assert.equal(gotEn.data.decisions.find(d => d.id === decId).question, dEn.question);
  core.setLanguages({ ai_language: 'ui' });
  const gotJa = core.get({ participant, ref: 'decisions' });
  assert.equal(gotJa.data.decisions.find(d => d.id === decId).question, dJa.question);

  // Verify schema version and decisions i18n columns
  const cols = core.db.prepare('PRAGMA table_info(decisions)').all().map(r => r.name);
  const sv = Number(core.one("SELECT value FROM meta WHERE key='schema_version'")?.value);
  assert.equal(sv, SCHEMA_VERSION);
  assert.ok(cols.includes('message_key'));
  assert.ok(cols.includes('message_args'));
});

test('i18n: rendering gui/app.js with ui_language=en produces zero Japanese across all tabs', async () => {
  const home = tmpDir('i18n-gui-render');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  try {
    const gui = async (method, params) => (await (await fetch(`http://127.0.0.1:${svc.port}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idleshift-token': svc.token },
      body: JSON.stringify({ method, params }),
    })).json());

    await gui('setLanguages', { ui_language: 'en', ai_language: 'en' });
    const projRes = await gui('createProject', { name: 'Alpha Project' });
    const projId = projRes.result.project;
    await gui('createGoal', {
      project: projId,
      goal: { title: 'Ship Feature X', outcome: 'All tests pass', done_evidence: 'npm test passes' }
    });
    const state = (await gui('state', {})).result;

    // Build minimal DOM shim for gui/app.js
    const makeEl = (tag) => {
      const el = {
        tagName: tag.toUpperCase(),
        nodeType: 1,
        children: [],
        attrs: {},
        style: {},
        value: '',
        checked: false,
        hidden: false,
        textContent: '',
        listeners: {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
        append(...kids) {
          for (const k of kids) {
            if (k && typeof k === 'object') this.children.push(k);
            else if (k != null) this.children.push({ nodeType: 3, textContent: String(k) });
          }
        },
        replaceChildren(...kids) { this.children = []; this.append(...kids); },
        contains() { return false; },
        showModal() { this.open = true; },
        close() { this.open = false; },
        focus() {},
      };
      return el;
    };
    const ids = { tabs: makeEl('nav'), banner: makeEl('div'), main: makeEl('main'), dlg: makeEl('dialog'), toast: makeEl('div'), conn: makeEl('div') };
    const collectText = (node) => {
      if (!node) return '';
      if (node.nodeType === 3) return node.textContent || '';
      const own = node.attrs?.title ? [node.attrs.title] : [];
      if (node.attrs?.placeholder) own.push(node.attrs.placeholder);
      if (node.textContent) own.push(node.textContent);
      return own.concat((node.children || []).map(collectText)).join(' ');
    };

    const dicts = loadGuiDicts();
    const ctx = {
      console,
      Date, Math, Number, String, Array, Object, Set, JSON, Promise,
      setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
      navigator: { language: 'en-US', languages: ['en-US'] },
      location: { hash: '', pathname: '/' },
      history: { replaceState() {} },
      sessionStorage: { getItem: () => 'tok', setItem() {} },
      fetch: async () => ({ status: 200, json: async () => ({ ok: true, result: state }) }),
      document: {
        documentElement: { lang: 'ja' },
        activeElement: null,
        getElementById: id => ids[id] || makeEl('div'),
        createElement: tag => makeEl(tag),
        createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
      },
      window: { GUI_I18N: dicts },
    };
    ctx.globalThis = ctx;
    vm.runInNewContext(fs.readFileSync(path.resolve('gui/app.js'), 'utf8'), ctx);

    ctx.S = state;
    for (const tName of ['home', 'connect', 'decisions', 'maintain']) {
      ctx.tab = tName;
      ctx.openGoal = null;
      ctx.render();
      assert.equal(ctx.document.documentElement.lang, 'en');
      const rendered = collectText(ids.tabs) + ' ' + collectText(ids.banner) + ' ' + collectText(ids.main);
      // Note: lang selector intentionally offers '日本語' as a native language name option in connect tab
      const cleaned = rendered.replace(/日本語/g, '');
      assert.equal(HAS_JP.test(cleaned), false, `Tab ${tName} rendered Japanese in en mode: ${cleaned}`);
    }
  } finally {
    await svc.stop();
  }
});

test('i18n: real HTTP service serves /i18n/en.js & ja.js (200) while blocking traversal (404), and renders en & ja', async () => {
  const home = tmpDir('i18n-http-e2e');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  try {
    const base = `http://127.0.0.1:${svc.port}`;
    const rIndex = await fetch(`${base}/`);
    assert.equal(rIndex.status, 200);
    const html = await rIndex.text();
    assert.ok(html.includes('i18n/en.js') && html.includes('i18n/ja.js'));

    const rApp = await fetch(`${base}/app.js`);
    assert.equal(rApp.status, 200);
    assert.match(rApp.headers.get('content-type') || '', /javascript/);
    const appCode = await rApp.text();

    const rEn = await fetch(`${base}/i18n/en.js`);
    assert.equal(rEn.status, 200);
    assert.match(rEn.headers.get('content-type') || '', /javascript/);
    const enCode = await rEn.text();

    const rJa = await fetch(`${base}/i18n/ja.js`);
    assert.equal(rJa.status, 200);
    assert.match(rJa.headers.get('content-type') || '', /javascript/);
    const jaCode = await rJa.text();

    for (const badPath of ['/../package.json', '/%2e%2e/package.json', '/i18n/../../package.json', '/other/app.js']) {
      const rBad = await fetch(`${base}${badPath}`);
      assert.equal(rBad.status, 404, `${badPath} must return 404`);
    }

    // Execute fetched scripts in vm and verify both en and ja render without falling back to raw keys
    const ctx = { window: {} };
    vm.runInNewContext(enCode, ctx);
    vm.runInNewContext(jaCode, ctx);
    assert.equal(ctx.window.GUI_I18N.en['tab.home'], 'Home');
    assert.equal(ctx.window.GUI_I18N.ja['tab.home'], 'ホーム');
    assert.ok(appCode.includes("gt('tab.' + k)"));
  } finally {
    await svc.stop();
  }
});

test('i18n: hosts, startPhrase, adapters.available and wakePrompt have zero Japanese in en mode', async () => {
  const { wakePrompt } = await import('../src/adapters.mjs');
  const { hostStatus } = await import('../src/hosts.mjs');

  assert.equal(HAS_JP.test(wakePrompt('C:\\work\\proj', 'en')), false);
  assert.equal(HAS_JP.test(wakePrompt('C:\\work\\proj', 'ja')), true);
  assert.equal(HAS_JP.test(JSON.stringify(hostStatus(process.env, 'en'))), false);

  const home = tmpDir('i18n-e6c');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  try {
    const gui = async (method, params) => (await (await fetch(`http://127.0.0.1:${svc.port}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idleshift-token': svc.token },
      body: JSON.stringify({ method, params }),
    })).json());

    await gui('setLanguages', { ui_language: 'en', ai_language: 'en' });
    const state = (await gui('state', {})).result;
    assert.equal(HAS_JP.test(JSON.stringify(state.hosts)), false, `hosts must have zero JP: ${JSON.stringify(state.hosts)}`);
    assert.equal(HAS_JP.test(JSON.stringify(state.adapters)), false, `adapters must have zero JP: ${JSON.stringify(state.adapters)}`);

    const phrase = (await gui('startPhrase', { root: 'C:\\work\\proj' })).result;
    assert.equal(HAS_JP.test(JSON.stringify(phrase)), false, `startPhrase must have zero JP: ${JSON.stringify(phrase)}`);
  } finally {
    await svc.stop();
  }
});
