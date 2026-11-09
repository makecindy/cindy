import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Production entry: evaluate the browser shim and invoke its public preload API.
// Regression: auth aliases doubled /api, local entry spread a Promise and
// invented access, and listActive wrapped options in an array. Server tests do
// not exercise this adapter. Tier: unit, no sockets or real account state.
// Measured standalone: node --test apps/host/src/web-shim.test.mjs, ~53 ms.
const source = fs.readFileSync(new URL('../../web/shim.js', import.meta.url), 'utf8');
function browser(respond = () => ({})) {
  const calls = [];
  const window = { crypto: { randomUUID: () => 'test-id' }, addEventListener() {} };
  const context = vm.createContext({
    window, navigator: { language: 'en', platform: 'test', clipboard: { writeText() {} } },
    document: { createElement: () => ({ dataset: {} }), head: { appendChild() {} } },
    location: { replace() {} }, console, TextDecoder,
    fetch: async (url, options) => {
      // Keep the background event subscription pending, without timers/handles.
      if (url.startsWith('/events')) return new Promise(() => {});
      const body = JSON.parse(options.body);
      calls.push({ url, body, credentials: options.credentials });
      const result = respond(url, body);
      return { ok: true, text: async () => JSON.stringify(result) };
    },
  });
  vm.runInContext(source, context);
  calls.length = 0; // Ignore the independent plugin-list boot read.
  return { api: window.electronAPI, calls };
}

test('both auth API shapes use the same Host routes', async () => {
  const b = browser(() => ({ isAuthenticated: true }));
  await b.api.auth.getState();
  await b.api.auth.refresh();
  await b.api.authInitialize();
  await b.api.authRefresh();
  assert.deepEqual(b.calls.map(c => c.url), [
    '/api/auth/state', '/api/auth/refresh', '/api/auth/state', '/api/auth/refresh',
  ]);
  assert.ok(b.calls.every(c => c.credentials === 'same-origin'));
});

test('entering the app preserves the actual Host auth verdict', async () => {
  for (const state of [
    { user: { id: 'test-user' }, mode: 'cloud', canEnterApp: true },
    { user: null, mode: 'signed-out', canEnterApp: false },
  ]) {
    const b = browser(() => state);
    assert.deepEqual(JSON.parse(JSON.stringify(await b.api.authEnterLocal())), state);
  }
});

test('active task queries retain their options object', async () => {
  const b = browser(() => ({ format: 'active-sessions-v2', sessions: [] }));
  const result = await b.api.maker.listActive({ includeRemote: false });
  assert.deepEqual(b.calls[0].body, { options: { includeRemote: false } });
  assert.equal(result.format, 'active-sessions-v2');
});

// An unsupported write used to resolve successfully even though nothing was
// saved. Exercise both the generic fallback and explicit placeholder routes.
test('unsupported web actions cannot report a successful save or execution', async () => {
  const b = browser();
  for (const action of [
    () => b.api.maker.schedule.create({ prompt: 'test' }),
    () => b.api.maker.createCustomMcpServer({ name: 'test' }),
    () => b.api.maker.setGoal('test-session', { text: 'test' }),
    () => b.api.localDb.sessionImport.start({}),
    () => b.api.profileUpdate({ name: 'test' }),
  ]) {
    await assert.rejects(action(), { code: 'HOST_CHANNEL_UNSUPPORTED' });
  }
  assert.equal(b.calls.length, 0);
});

// Local setters must invalidate synchronous reads without waiting for SSE:
// otherwise the next drag or appearance edit starts from the old snapshot.
test('local setting writes and resets invalidate their synchronous snapshots', async () => {
  const b = browser(url => url.includes('/reset') ? { value: 'reset' } : { value: 'saved' });
  for (const [get, write, reset, unwrap] of [
    [() => b.api.layout.getStateSync(), () => b.api.layout.set({}), () => b.api.layout.reset(), x => x.layout],
    [() => b.api.appearanceSettings.getSync(), () => b.api.appearanceSettings.setPatch({}), () => b.api.appearanceSettings.reset(), x => x],
  ]) {
    get(); await write(); assert.equal(unwrap(get()).value, 'saved');
    await reset(); assert.equal(unwrap(get()).value, 'reset');
  }
});
