// Unit: production handoff admissions; no live process or input. Regressions
// cover a call during freeze, disconnect after dispatch, cancellation, and an
// owner change while draining. Existing HTTP tests cannot distinguish replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformClientHandoff } from './client-handoff.mjs';
const identity = { id: 'old', pid: 12 };
const client = extra => ({ ...identity, call: async () => 'old', canDetach: async () => true, resume: async () => true, ...extra });

test('only undispatched calls resume on a replacement client', async () => {
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  let oldCalls = 0, newCalls = 0;
  gate.attach(client({ call: async () => { oldCalls++; } }));
  await gate.prepare(identity);
  const work = gate.call({ action: 'click' });
  assert.equal(gate.status().waiting, 1);
  gate.detach(identity);
  gate.attach(client({ id: 'new', pid: 13, call: async () => { newCalls++; return 'done'; } }));
  assert.equal(await work, 'done');
  assert.equal(oldCalls, 0); assert.equal(newCalls, 1);
  gate.close();
});

test('busy input and live page state refuse switching without disabling tools', async () => {
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  let finish;
  gate.attach(client({ call: () => new Promise(resolve => { finish = resolve; }), canDetach: async () => false }));
  const work = gate.call({ action: 'input' });
  await assert.rejects(gate.prepare(identity), /BUSY/);
  finish('done'); await work;
  await assert.rejects(gate.prepare(identity), /STATE_REQUIRES_CLIENT/);
  assert.equal(gate.status().paused, false); gate.close();
});

test('lost client requests are never replayed and require proof of retirement', async () => {
  let retired = false;
  const gate = createPlatformClientHandoff({ assertCurrent() {}, isRetired: async () => retired });
  let finish, replacementCalls = 0;
  gate.attach(client({ call: () => new Promise(resolve => { finish = resolve; }) }));
  const work = gate.call({ action: 'submit' });
  gate.lost(identity);
  const replacement = client({ id: 'new', pid: 13, call: async () => { replacementCalls++; } });
  assert.throws(() => gate.attach(replacement), /ALREADY_ATTACHED/);
  const rejected = assert.rejects(work, /UNCERTAIN/);
  finish('submitted'); await rejected;
  await assert.rejects(gate.retireLost(identity), /EXIT_UNCONFIRMED/);
  retired = true; await gate.retireLost(identity);
  gate.attach(replacement);
  assert.equal(replacementCalls, 0); gate.close();
});

test('cancelled queued operations do not run after attachment', async () => {
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  const abort = new AbortController();
  const work = gate.call({}, { signal: abort.signal });
  const rejected = assert.rejects(work, /cancelled/);
  abort.abort(Error('cancelled')); await rejected;
  let calls = 0; gate.attach(client({ call: async () => { calls++; } }));
  assert.equal(gate.status().waiting, 0); assert.equal(calls, 0); gate.close();
});

test('account change during drain never admits the old result', async () => {
  let current = true, finish;
  const gate = createPlatformClientHandoff({ assertCurrent() { if (!current) throw Error('OWNER_CHANGED'); } });
  gate.attach(client({ canDetach: () => new Promise(resolve => { finish = resolve; }) }));
  const preparing = gate.prepare(identity);
  const rejected = assert.rejects(preparing, /OWNER_CHANGED/);
  current = false; finish(true); await rejected; gate.close();
});


test('detach cannot race the client freeze, and lost clients stay paused', async () => {
  let finish;
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  gate.attach(client({ canDetach: () => new Promise(resolve => { finish = resolve; }) }));
  const preparing = gate.prepare(identity);
  assert.throws(() => gate.detach(identity), /NOT_DRAINED/);
  await assert.rejects(gate.cancel(identity), /CHANGED/);
  gate.lost(identity);
  const rejected = assert.rejects(preparing, /CHANGED/);
  finish(true); await rejected;
  assert.equal(gate.status().paused, true);
  gate.close();
});

test('cancel resumes the old client before dispatching queued work', async () => {
  const events = [];
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  gate.attach(client({ resume: async () => { events.push('resume'); return true; }, call: async () => events.push('input') }));
  await gate.prepare(identity);
  const work = gate.call({});
  await gate.cancel(identity); await work;
  assert.deepEqual(events, ['resume', 'input']); gate.close();
});


test('uncertain freeze waits for explicit resume rather than dispatching input', async () => {
  const events = [];
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  gate.attach(client({ canDetach: async () => { throw Error('connection lost'); },
    resume: async () => { events.push('resume'); return true; }, call: async () => events.push('input') }));
  await assert.rejects(gate.prepare(identity), /connection lost/);
  assert.equal(gate.status().paused, true);
  assert.throws(() => gate.detach(identity), /NOT_DRAINED/);
  const work = gate.call({});
  await gate.cancel(identity); await work;
  assert.deepEqual(events, ['resume', 'input']); gate.close();
});

test('same-process reconnect preserves a freeze and cannot admit a different process', async () => {
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  gate.attach(client());
  await gate.prepare(identity);
  gate.lost(identity);
  assert.throws(() => gate.reconnect(client({ pid: 99 }), true), /NOT_DRAINED/);
  let calls = 0;
  gate.reconnect(client({ call: async () => ++calls }), true);
  const work = gate.call({ action: 'click' });
  assert.equal(gate.status().paused, true); assert.equal(calls, 0);
  await gate.cancel(identity);
  assert.equal(await work, 1);
  gate.close();
});

// Closing an old task must neither wait for a window nor clean a replacement's
// unrelated native session. Exercise the same dispatch/cleanup gate as tools.
test('session cleanup stays with its executor across window replacement', async () => {
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  const calls = [];
  gate.attach(client({ call: async operation => calls.push(['old', operation]) }));
  await gate.call('input', { sessionId: 'old-task' });
  await gate.prepare(identity);
  gate.detach(identity);
  await gate.cleanupSession('never-used', 'cleanup');
  assert.equal(gate.status().waiting, 0);
  gate.attach(client({ id: 'new', pid: 13, call: async operation => calls.push(['new', operation]) }));
  await gate.cleanupSession('old-task', 'cleanup');
  await gate.call('input', { sessionId: 'new-task' });
  await gate.cleanupSession('new-task', 'cleanup');
  assert.deepEqual(calls, [['old', 'input'], ['new', 'input'], ['new', 'cleanup']]);
  gate.close();
});

// A transport may settle after cancellation. Never accept that late success,
// even if its executor ignored the abort signal; already sent work is not replayed.
test('cancelled in-flight calls cannot return a late successful result', async () => {
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  const abort = new AbortController();
  let finish;
  gate.attach(client({ call: () => new Promise(resolve => { finish = resolve; }) }));
  const pending = gate.call({}, { signal: abort.signal });
  const rejected = assert.rejects(pending, /disposed/);
  abort.abort(Error('disposed'));
  finish('late success'); await rejected;
  assert.equal(gate.status().inFlight, 0);
  gate.close();
});

// Cancellation also wins when attach has already woken the waiter but its
// continuation has not run. Neither event ordering may dispatch stale input.
for (const wakeFirst of [false, true]) test(`abort wins queued dispatch (wake first: ${wakeFirst})`, async () => {
  const gate = createPlatformClientHandoff({ assertCurrent() {} });
  const abort = new AbortController();
  let calls = 0;
  const pending = gate.call({}, { signal: abort.signal });
  const rejected = assert.rejects(pending, /disposed/);
  if (wakeFirst) gate.attach(client({ call: async () => calls++ }));
  abort.abort(Error('disposed'));
  if (!wakeFirst) gate.attach(client({ call: async () => calls++ }));
  await rejected;
  assert.equal(calls, 0); assert.equal(gate.status().waiting, 0);
  gate.close();
});
