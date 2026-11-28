// Integration, real headless Chromium through the Host's plugin sandbox (plugins/chromium-sandbox.ts)
// and the shared GhostRuntime: the hook fixture the 8i tests will use (release table row 33). Rule: the
// fixture starts as a logic plugin, answers the hook it is asked with the verdict it was written with,
// takes no delivery once stopped, and closing the sandbox leaves no browser process behind.
// Gap: no Host test started a plugin that answers hooks; the 8i tests need one that comes and goes
// cleanly. Minimal input: one plugin, one will-user-message event. Skipped without a Chromium build
// (CINDY_TEST_CHROMIUM), never a user's browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lifoCleanup } from './cleanup.mjs';
import { chromiumUnavailable, processesRunning, startHookPluginSandbox, testChromiumExecutable, writeHookPlugin } from './hook-plugin-fixture.mjs';

const executablePath = testChromiumExecutable();

test('the hook fixture plugin answers the hook it is asked, takes nothing once stopped, and leaves no browser process', {
  skip: executablePath ? false : chromiumUnavailable, timeout: 30_000,
}, async t => {
  t = lifoCleanup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-hook-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = await processesRunning(executablePath);
  const sent = [];
  const ghost = writeHookPlugin(path.join(dir, 'plugin'), {
    behaviors: { 'will-user-message': { action: 'rewrite', text: 'redacted text' } },
  });
  const sandbox = await startHookPluginSandbox({ ghosts: [ghost], executablePath, onSend: (id, payload) => { sent.push({ id, payload }); } });
  let closed = false;
  t.after(() => closed ? undefined : sandbox.close());

  assert.deepEqual(await sandbox.spawn(ghost), { ok: true, state: 'running' });
  const event = { type: 'event', name: 'will-user-message', hookId: 'hook-1', data: { sessionId: 'task-1', text: 'my secret' } };
  assert.equal(await sandbox.deliver(ghost, event), true);
  const verdicts = () => sent.filter(item => item.payload?.type === 'event-verdict');
  for (let attempt = 0; attempt < 400 && verdicts().length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(verdicts(), [{ id: sandbox.id(ghost), payload: { type: 'event-verdict', hookId: 'hook-1', action: 'rewrite', text: 'redacted text' } }]);
  assert.deepEqual(sent.find(item => item.payload?.type === 'fixture-received')?.payload.message, event);

  sandbox.runtime.stop(sandbox.id(ghost));
  assert.equal(await sandbox.deliver(ghost, { ...event, hookId: 'hook-2' }), false);
  await sandbox.close();
  closed = true;
  const after = await processesRunning(executablePath);
  assert.deepEqual([...after].filter(pid => !before.has(pid)), []);
});
