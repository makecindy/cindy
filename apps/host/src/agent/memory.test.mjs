import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRequire } from 'node:module';

import { readMemorySettings, createHostMemoryManager, createHostMemoryMcpProviders, attachAgentsToMakerMemory } from './memory.mjs';
import { configureHostOwner } from './claude-auth.mjs';
import { beginAppSessionBoundary } from '../../../desktop/src/main/appSessionState.ts';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { lifoCleanup } from '../test-support/cleanup.mjs';
import { createHostAutoReview } from './auto-review.ts';
import { hostOutbound } from '../outbound.mjs';
import { getModelAccessCredentialsStore } from '../../../desktop/src/main/model-access/credentialsStore.ts';
import { ownerScopedUserDataPath } from '../../../desktop/src/main/appSessionState.ts';
import { setModelsDisabled } from '../../../desktop/src/main/maker-host/model-disable-store.ts';

const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

/**
 * The toggle decides whether cindy_memory is registered at all, so a corrupt or
 * partial file must fall back to the defaults instead of disabling memory.
 */
test('reads the owner memory settings, defaulting missing or corrupt fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-memory-settings-'));
  try {
    const file = path.join(root, 'memory-settings.json');
    assert.deepEqual(readMemorySettings(root), { maker: true, claudeCode: true, codex: true, pi: true });

    fs.writeFileSync(file, JSON.stringify({ maker: false }));
    assert.deepEqual(readMemorySettings(root), { maker: false, claudeCode: true, codex: true, pi: true });

    fs.writeFileSync(file, '{ not json');
    assert.equal(readMemorySettings(root).maker, true);

    fs.writeFileSync(file, JSON.stringify({ maker: 'yes' }));
    assert.equal(readMemorySettings(root).maker, true, 'a non-boolean is ignored');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The old Host wired a constant owner/generation: a retained MCP call could
// still open the outgoing owner's memory during sign-out or after switching.
// Unit: call the real factory's getStore under a boundary, then another owner;
// rejection must precede creating either owner's SQLite or storage directory.
test('memory retained by an old task cannot reopen storage across an account boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-memory-boundary-'));
  let manager, release;
  try {
    configureHostOwner({ userDataDir: root, ownerId: 'memory-owner-a' });
    manager = createHostMemoryManager({ userDataDir: root, ownerId: 'memory-owner-a' });
    release = beginAppSessionBoundary();
    await assert.rejects(manager.getStore(root), /not.ready|owner/i);
    configureHostOwner({ userDataDir: root, ownerId: 'memory-owner-b' });
    release(); release = null;
    await assert.rejects(manager.getStore(root), /not.ready|owner/i);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    release?.(); manager?.dispose();
    configureHostOwner({ userDataDir: root, ownerId: null });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * cindy_memory on the Host, called the way an Agent calls it: the provider main.ts registers
 * (createHostMemoryMcpProviders), over MCP, with the review agent attached as main.ts attaches the
 * agent graph. The attached agent counts its one-shot calls: in runReview it is the only way to a
 * model once no auxiliary chain is injected. The owner database is open and current, as in main.ts,
 * with the calling task 'task-memory' in it: every memory call checks its caller against it.
 */
async function hostMemoryFixture(t, ownerId, makeReview) {
  // The database lives in the fixture's profile: close it before the profile is removed.
  t = lifoCleanup(t);
  // Real path: a teammate project is recognised from its absolute path, which macOS tmp links hide.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-memory-review-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: root, ownerId });
  t.after(() => configureHostOwner({ userDataDir: root, ownerId: null }));
  // The development build refuses to migrate what it takes for the official shared profile
  // (XDT_OFFICIAL_SHARED_PROFILE=1 inside a Cindy task); this is a fixture profile.
  const sharedProfile = process.env.XDT_OFFICIAL_SHARED_PROFILE;
  delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
  t.after(() => { if (sharedProfile !== undefined) process.env.XDT_OFFICIAL_SHARED_PROFILE = sharedProfile; });
  configureAppDataDir(path.join(root, 'app-data'));
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: root, ownerId, isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, ownerId);
  t.after(async () => { clearCurrentDbClient(); await database.dispose(); });
  opened.db.exec(`INSERT INTO sessions(id,source,status,created_at,updated_at) VALUES ('task-memory','desktop','active',1,1);`);

  const manager = createHostMemoryManager({ userDataDir: root, ownerId, review: makeReview?.(root) });
  t.after(() => manager.dispose());
  const oneShots = [];
  attachAgentsToMakerMemory(manager, { 'claude-code': { oneShot: async prompt => { oneShots.push(prompt); return 'merge nothing'; } } });
  const helperDecisions = [];
  // Runs inside session_search, between its first checks and the search (memory-mcp-ports.ts).
  const hooks = { duringHistoryDecision: () => {} };
  const provider = createHostMemoryMcpProviders(manager, {
    readsAccountHistory: async sessionId => { helperDecisions.push(sessionId); hooks.duringHistoryDecision(); return false; },
    deviceId: () => 'host-device',
  }).find(p => p.name === 'cindy_memory');
  const connect = async (workingDir, sessionId = 'task-memory') => {
    const { instance } = provider.toClaudeSdkConfig({ sessionId, agentKind: 'claude-code', workingDir });
    const client = new Client({ name: 'host-memory-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), instance.connect(b)]);
    t.after(async () => { await client.close(); await instance.close(); });
    return (name, args = {}) => client.callTool({ name: 'call_tool', arguments: { name, args } });
  };
  return { root, db: opened.db, drizzle: opened.drizzle, database, ownerId, oneShots, connect, helperDecisions, hooks };
}

const NOTE = { type: 'project', name: 'release-notes', title: 'Release notes', description: 'Where the release notes live', body: 'docs/release.md' };

// §3.2 integration: real MCP, manager, dispatch and temporary SQLite. A stored
// memory under a chosen auxiliary chain produces the selected request and one
// receipt. The baseline always refused review; its default fallback must remain unused.
test('memory_review respects the auxiliary chain, holds and the request owner', async t => {
  let held = null, defaultDisabled = false;
  let onRequest = () => {};
  const requests = [];
  t.mock.method(hostOutbound, 'outboundUndiciFetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    onRequest();
    return Response.json({ choices: [{ message: { content: 'Keep both notes' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 } });
  });
  const endpoint = 'https://memory-unit.test';
  const f = await hostMemoryFixture(t, 'memory-review-owner', userDataDir => {
    getModelAccessCredentialsStore().setServerCredentials(endpoint);
    return createHostAutoReview({
      userDataDir,
      getMaker: () => ({ listAvailableAgents: () => [] }),
      gateway: { credential: 'fixture-key', endpoint },
      providerConfig: { publicViews: async () => defaultDisabled
        ? [{ id: 'xd', connected: true, suspended: true, agents: ['claude-code'], models: {} }] : [] },
      logger: { debug() {}, info() {}, warn() {} },
    }).memoryReview(() => held);
  });
  const workdir = path.join(f.root, 'project');
  fs.mkdirSync(workdir);
  const call = await f.connect(workdir);
  const written = await call('memory_write', NOTE);
  assert.notEqual(written.isError, true, JSON.stringify(written));
  const settings = ownerScopedUserDataPath('auxiliary-model-settings.json');
  const chain = models => fs.writeFileSync(settings, JSON.stringify({ models }));
  const selected = 'litellm-deepseek-v4-flash';
  const model = 'deepseek/deepseek-v4-flash';
  const review = () => call('memory_review');
  const refuse = async pattern => {
    requests.length = 0;
    const result = await review();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, pattern);
    assert.deepEqual(requests, []);
  };
  chain([selected]);
  await t.test('dispatches the selected auxiliary model', async () => {
    const result = await review();
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(requests.map(request => request.model), [model]);
  });
  await t.test('skips a disabled auxiliary candidate with zero requests', async () => {
    setModelsDisabled('xd', [model], true);
    try { await refuse(/auxiliary model chain produced no text/); }
    finally { setModelsDisabled('xd', [model], false); }
  });
  await t.test('rejects an unavailable auxiliary chain without falling back', async () => {
    chain(['codex-gpt-5.4-mini']);
    try { await refuse(/auxiliary model chain produced no text/); }
    finally { chain([selected]); }
  });
  await t.test('returns the Host hold refusal with zero requests', async () => {
    held = 'HOST_PROFILE_IN_USE_BY_DESKTOP: The desktop window is using this profile.';
    try { await refuse(/"code":"PRECONDITION_FAILED".*desktop window/); }
    finally { held = null; }
  });
  await t.test('records the usage once in the database captured before dispatch', async () => {
    const incoming = [];
    const incomingDb = { drizzle: { insert() { incoming.push(true); throw new Error('wrong account'); } } };
    f.db.exec('DELETE FROM auxiliary_usage_receipts');
    onRequest = () => setCurrentDbClient(incomingDb, 'next-memory-owner');
    try { await review(); }
    finally { setCurrentDbClient(f.database, f.ownerId); onRequest = () => {}; }
    assert.deepEqual(f.db.prepare('SELECT source, model, input_tokens, output_tokens FROM auxiliary_usage_receipts').all(),
      [{ source: 'memory-review', model, input_tokens: 9, output_tokens: 4 }]);
    assert.deepEqual(incoming, []);
  });
  await t.test('rejects a disabled default source with zero requests', async () => {
    defaultDisabled = true;
    try { await refuse(/one-shot route for 'claude-code' is disabled/); }
    finally { defaultDisabled = false; }
    const result = await review();
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(requests.map(request => request.model), [model]);
  });
  assert.deepEqual(f.oneShots, []);
});

// The desktop maps a scope that is one of this owner's teammate projects to the project's own
// memory folder (maker-memory-host.ts projectMemoryDir); the Host did not bind it, so a Host task
// in that folder stored the memory at the historical place the desktop no longer reads.
// Minimal failing input: a memory_write from a task whose working directory is a teammate project.
test('a memory written from a teammate project lands in the project folder, as on the desktop', async t => {
  const ownerId = 'memory-project-owner';
  const f = await hostMemoryFixture(t, ownerId);
  const workspace = path.join(f.root, 'owners', dataOwnerStorageKey(ownerId), 'bots', 'helper', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const call = await f.connect(workspace);
  const written = await call('memory_write', NOTE);
  assert.notEqual(written.isError, true, JSON.stringify(written));
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.cindy', 'memory')).filter(name => name.endsWith('.md') && name.includes('release-notes')).length, 1);
});

// The desktop binds session_search to the messages_fts search (mcp-providers.ts searchSessions); the
// Host did not, so the tool was not registered and a Host task could not search its task history.
// Minimal failing input: one stored message, then session_search from a task of the same account.
// Tier: unit, real migrated owner database in a temp profile, in-process MCP.
test('session_search on the Host finds task history, with the desktop checks on the caller', async t => {
  const f = await hostMemoryFixture(t, 'memory-search-owner');
  f.db.exec(`INSERT INTO sessions(id,source,status,created_at,updated_at) VALUES ('task-earlier','desktop','active',1,1);
    INSERT INTO messages(id,client_id,session_id,role,content,created_at)
      VALUES ('m-earlier','c-earlier','task-earlier','user','"where is the release checklist"',1);`);
  const workdir = path.join(f.root, 'project');
  fs.mkdirSync(workdir);

  const search = await (await f.connect(workdir))('session_search', { query: 'checklist' });
  assert.notEqual(search.isError, true, JSON.stringify(search));
  const { hits } = JSON.parse(search.content[0].text).data;
  assert.deepEqual(hits.map(hit => [hit.sessionId, hit.messageId, hit.sessionUrl]),
    [['task-earlier', 'm-earlier', 'cindy://session/task-earlier?device=host-device']]);
  assert.deepEqual(f.helperDecisions, ['task-memory']);

  // A caller that is not a task of this account (the desktop's restricted surface) is refused.
  const stranger = await (await f.connect(workdir, 'task-elsewhere'))('session_search', { query: 'checklist' });
  assert.equal(stranger.isError, true);
  assert.match(stranger.content[0].text, /unavailable for this task/);
});

// The desktop wraps every cindy_memory call in withAccountDataAccess (mcp-providers.ts): the calling
// task must be in the current database. The Host bound nothing there, so after an account change a
// task of the previous account still read and wrote memories, now the new account's: only
// session_search checked its caller. Gap: the tests above call from a task of the current database.
// Minimal failing input: memory_write from a task id the current database does not have, and from a
// task whose database is no longer current. Tier: unit, real migrated owner database, in-process MCP.
test('a memory call from a task outside the current account is refused, as on the desktop', async t => {
  const f = await hostMemoryFixture(t, 'memory-access-owner');
  const workdir = path.join(f.root, 'project');
  fs.mkdirSync(workdir);
  const refused = { isError: true, content: [{ type: 'text', text: JSON.stringify({
    ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE', message: 'Account data is unavailable for this task.' }) }] };

  const previousAccountTask = await f.connect(workdir, 'task-previous-account');
  assert.deepEqual(await previousAccountTask('memory_write', NOTE), refused);
  assert.deepEqual(await previousAccountTask('memory_search', { query: 'release' }), refused);

  // The account's database is closed for an account change while its task is still running.
  const task = await f.connect(workdir);
  clearCurrentDbClient();
  assert.deepEqual(await task('memory_write', NOTE), refused);

  const stored = fs.readdirSync(f.root, { recursive: true }).filter(name => String(name).includes('release-notes'));
  assert.deepEqual(stored, []);
});

// The checks run again before a result leaves (the desktop closures re-check the database after the
// operation): an account change during the call must not hand back what was read for the old one.
// Gap: the test above changes the account between calls. Minimal failing input: another database
// becomes current while session_search runs, after its history decision; the search itself still
// finds the hit (the same file under a new client), so only the re-check stops it. Tier: unit, as above.
test('session_search refuses its result when the account changes during the call', async t => {
  const f = await hostMemoryFixture(t, 'memory-midcall-owner');
  f.db.exec(`INSERT INTO messages(id,client_id,session_id,role,content,created_at)
    VALUES ('m-own','c-own','task-memory','user','"where is the release checklist"',1);`);
  const workdir = path.join(f.root, 'project');
  fs.mkdirSync(workdir);
  const search = await f.connect(workdir);
  const next = createDbClientForHandle({ db: f.db, drizzle: f.drizzle });
  f.hooks.duringHistoryDecision = () => setCurrentDbClient(next, f.ownerId);
  const result = await search('session_search', { query: 'checklist' });
  assert.deepEqual(f.helperDecisions, ['task-memory']);
  assert.deepEqual(result, { isError: true, content: [{ type: 'text', text: JSON.stringify({
    ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE', message: 'Account data is unavailable for this task.' }) }] });
});
