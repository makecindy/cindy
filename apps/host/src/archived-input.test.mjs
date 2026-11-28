import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ownerScopedPath } from '../../desktop/src/main/dataOwnerPath.ts';
import { readHostEndpoint, readHostProcessStatus, requestHostStop } from './control.mjs';
import { ownerDatabasePath } from './profile-path.mjs';

const owner = 'archived-input-owner';
const hostDir = fileURLToPath(new URL('../', import.meta.url));

// Real CLI, HTTP, queue and SQLite (loopback integration). The old queue's stub
// restore bypassed the real status reader. An archived row is the failing input.
test('production input restores an archived task only for an admitted new client ID', { timeout: 80000 }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cindy-archived-input-'));
  let child, exited, db;
  try {
    const endpoints = path.join(profile, 'endpoints');
    const home = path.join(profile, 'home');
    await Promise.all([mkdir(endpoints), mkdir(home), mkdir(path.join(profile, '.dev-instances'))]);
    await writeFile(path.join(endpoints, 'endpoint.global.json'), JSON.stringify({
      authApiBaseUrl: 'https://fixture.invalid', modelAccessApiBaseUrl: 'https://fixture.invalid', deviceLinkApiBaseUrl: 'https://fixture.invalid',
    }));
    // The fixture uses a fake engine. Use the normal opt-out so startup does
    // not spend the readiness budget trying to obtain gateway credentials.
    const ownerRoot = ownerScopedPath(profile, owner);
    await mkdir(ownerRoot, { recursive: true });
    await writeFile(path.join(ownerRoot, 'model-disable-prefs.json'), JSON.stringify({ disabledProviders: { xd: true } }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(path|systemroot|tmpdir|tmp|temp|lang|lc_all|lc_ctype)$/i.test(key)));
    child = spawn(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs',
      '--import', './src/test-support/archived-input-account.mjs', 'src/main.ts', 'serve'], {
      cwd: hostDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, HOME: home, USERPROFILE: home,
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'),
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
        XDG_DATA_HOME: path.join(home, 'data'), CINDY_HOST_DATA_DIR: profile,
        CINDY_HOST_APP_DATA_DIR: path.join(profile, 'app-data'), CINDY_HOST_ENDPOINT_DIR: endpoints,
        ...(process.env.CINDY_HOST_SQLITE_VEC_PATH && { CINDY_HOST_SQLITE_VEC_PATH: process.env.CINDY_HOST_SQLITE_VEC_PATH }),
        CINDY_HOST_OWNER: owner, CINDY_HOST_PORT: '0', XDT_DEVICE_ID_OVERRIDE: 'fixture-archive-device',
        XDT_DISABLE_MODELS_FETCH: '1', CINDY_HOST_REGION: 'global', GIT_NO_LAZY_FETCH: '1' },
    });
    exited = once(child, 'exit');
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { output = (output + chunk.toString()).slice(-8000); });
    }
    let endpoint, status;
    const appLog = async () => {
      const log = path.join(profile, 'logs', `main-${new Date().toISOString().slice(0, 10)}.log`);
      return (await readFile(log, 'utf8').catch(() => '')).slice(-5000);
    };
    for (let i = 0; i < 900; i++) {
      assert.equal(child.exitCode, null, output);
      const found = readHostEndpoint(profile);
      if (found) {
        status = await readHostProcessStatus(profile);
        if (status.runtime?.state === 'ready') { endpoint = found; break; }
        assert.ok(!['blocked', 'error'].includes(status.runtime?.state), JSON.stringify(status.runtime));
      }
      await delay(50);
    }
    assert.ok(endpoint, `${output}\n${JSON.stringify(status)}\n${await appLog()}`);
    const token = (await readFile(path.join(profile, 'host-api-token'), 'utf8')).trim();
    const post = async (pathname, body) => {
      const response = await fetch(endpoint.baseUrl + pathname, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${token}`, origin: endpoint.baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return [response.status, await response.text()];
    };
    db = new Database(ownerDatabasePath(profile, owner), { fileMustExist: true });
    const insert = db.prepare(`INSERT INTO sessions
      (id,source,status,working_dir,agent_kind,model,created_at,updated_at,hidden_at,cleared_at)
      VALUES (?,?,?,?,'codex','fixture',1,1,?,?)`);
    const statusFor = db.prepare('SELECT status FROM sessions WHERE id = ?').pluck();
    const userRows = db.prepare("SELECT client_id FROM messages WHERE session_id = ? AND role = 'user'").pluck();
    const snapshots = db.prepare('SELECT count(*) FROM agent_input_queue_snapshots WHERE session_id = ?').pluck();
    const enqueue = (sessionId, item, options) => post('/api/input/enqueue', { sessionId, item, options });
    const item = { clientId: 'new-input', text: 'Continue this task' };

    insert.run('archive', 'desktop', 'archived', profile, null, null);
    const acceptedAt = performance.now();
    const [acceptedStatus, body] = await enqueue('archive', item, { expectedClearBoundaryMs: null });
    const acceptedInMs = Math.round(performance.now() - acceptedAt);
    console.info(`archived enqueue accepted in ${acceptedInMs}ms`);
    assert.equal(acceptedStatus, 200, body);
    assert.equal(statusFor.get('archive'), 'active');
    const [duplicateStatus, duplicateBody] = await enqueue('archive', item);
    assert.equal(duplicateStatus, 200, duplicateBody);
    for (let i = 0; i < 80 && userRows.all('archive').length === 0; i++) await delay(25);
    assert.deepEqual(userRows.all('archive'), ['new-input'], output + await appLog());
    // A persisted retry must leave an archived task alone.
    insert.run('duplicate', 'desktop', 'archived', profile, null, null);
    db.prepare(`INSERT INTO messages (id,client_id,session_id,role,content,created_at)
      VALUES ('old','new-input','duplicate','user','Already received',1)`).run();
    const [persistedStatus, persistedBody] = await enqueue('duplicate', item);
    assert.equal(persistedStatus, 200, persistedBody);
    assert.equal(statusFor.get('duplicate'), 'archived');
    assert.deepEqual(userRows.all('duplicate'), ['new-input']);
    assert.equal(snapshots.get('duplicate'), 0);

    for (const [id, source, status, hiddenAt, clearedAt, offered, options, message] of [
      ['deleted', 'desktop', 'deleted', null, null, item, {}, /NOT_FOUND/],
      ['hidden', 'desktop', 'archived', 2, null, item, {}, /NOT_FOUND/],
      ['managed', 'bot', 'archived', null, null, item, {}, /UNSUPPORTED_CAPABILITY/],
      ['invalid', 'desktop', 'archived', null, null, { clientId: 'empty' }, {}, /message text is required/],
      ['cleared', 'desktop', 'archived', null, 42, item, { expectedClearBoundaryMs: null }, /REMOTE_OPTIMISTIC_INPUT_CLEARED/],
    ]) {
      insert.run(id, source, status, profile, hiddenAt, clearedAt);
      const [deniedStatus, deniedBody] = await enqueue(id, offered, options);
      assert.ok(deniedStatus >= 400, deniedBody);
      assert.match(deniedBody, message);
      assert.equal(statusFor.get(id), status, id);
      assert.deepEqual(userRows.all(id), [], id);
      assert.equal(snapshots.get(id), 0, id);
    }
  } finally {
    db?.close();
    if (child && exited) {
      if (child.exitCode === null && child.signalCode === null) {
        const endpoint = readHostEndpoint(profile);
        if (endpoint?.pid === child.pid) await requestHostStop(profile).catch(() => child.kill('SIGTERM'));
        else child.kill('SIGTERM');
      }
      // real-wait: bound shutdown of the real child if the authenticated stop cannot complete.
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(profile, { recursive: true, force: true });
  }
});
