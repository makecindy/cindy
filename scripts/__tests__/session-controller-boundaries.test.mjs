import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectSessionBoundaries, verifySessionBoundaries } from '../session-controller-boundaries.mjs';

test('new host imports, direct mutations and additional calls fail the Session boundary', () => {
  const file = 'apps/desktop/src/main/new-host.ts';
  const found = inspectSessionBoundaries(`import { openSession as rawCreate } from './localDb/sessionOpening.js';
    async function newCaller() { await maker.createSession({}); await session.abort(); }`, file);
  assert.equal(found.size, 3);
  assert.equal(verifySessionBoundaries(found, []).length, 3);
  const registered = [...found].map(([key, count]) => { const [file, kind, owner, symbol] = JSON.parse(key);
    return { file, kind, owner, symbol, count, responsibility: 'Host lifecycle', reason: 'Exact implementation port', path: 'SessionController', exit: 'Remove when this port is removed' }; });
  assert.deepEqual(verifySessionBoundaries(found, registered), []);
  const extra = inspectSessionBoundaries('async function newCaller() { await maker.createSession({}); await maker.createSession({}); }', file);
  assert.ok(verifySessionBoundaries(extra, registered).length > 0);
});

test('does not mistake the renderer transport or AbortController for native Session calls', () => {
  assert.equal(inspectSessionBoundaries('window.electronAPI.maker.createSession({}); abortController.abort();', 'apps/desktop/src/renderer/view.ts').size, 0);
  assert.equal(inspectSessionBoundaries('this.current?.abortController.abort();', 'apps/desktop/src/main/transfer.ts').size, 0);
});

test('dynamic imports, namespace imports and imported write aliases cannot add an unregistered path', () => {
  const file = 'apps/desktop/src/main/new-caller.ts';
  const found = inspectSessionBoundaries(`import { openSession as rawCreate } from './localDb/sessionOpening.js';
    import * as records from './localDb/ipc/sessions.js';
    async function run() { const native = await import('./maker-host/index.js'); await rawCreate({}); workerSession.send('hello'); }`, file);
  assert.equal(found.size, 5);
  assert.equal(verifySessionBoundaries(found, []).length, 5);
});
