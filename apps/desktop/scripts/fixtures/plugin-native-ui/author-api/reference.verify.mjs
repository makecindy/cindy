/** Exercise the shipped author example itself in separate simulated plugin runtimes. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const reference = await readFile(new URL('../../../../resources/system-skills/cindy-plugin-creator/examples/native-ui-reference/main.js', import.meta.url), 'utf8');
function harness(withUi = true, points = ['composer.tools'], tabViews = false) {
  let listener;
  const handlers = new Map();
  const registrations = [], invalidations = [];
  const receipts = new Map(); let sequence = 0;
  runInNewContext(reference, { cindy: {
    onHostMessage: cb => { listener = cb; },
    send: async message => { receipts.get(message.callId)?.(message); return { ok: true }; },
    ...(withUi ? { ui: { capabilities: async () => ({ points, tabViews }),
      contribute: (id, value) => { registrations.push(id); handlers.set(id, value); },
      invalidate: input => invalidations.push(input) } } : {}),
  } });
  const context = sessionId => ({ scope: { kind: 'session', sessionId },
    capabilities: { version: 1, points, primitives: ['select'], effects: [], pages: [] } });
  return { ready: Promise.resolve(), registrations, invalidations,
    open: (id, context) => handlers.get(id).onAction({ actionId: 'open', values: {}, context }),
    action: (sessionId, format, actionId = 'set-format', id = 'output-format') => handlers.get(id).onAction({ actionId, values: { format }, context: context(sessionId) }),
    render: (sessionId, id = 'output-format') => handlers.get(id).render(context(sessionId)),
    preview: (sessionId, text) => new Promise(resolve => {
      const callId = `call-${++sequence}`; receipts.set(callId, resolve);
      listener({ type: 'tool-call', callId, tool: 'preview', args: { text, session_context: { session_id: sessionId } } });
    }),
  };
}
test('named views use existing task/message actions and keep Host destinations out of author results', async () => {
  const h = harness(true, ['session.header.actions', 'message.actions'], true); await h.ready;
  assert.deepEqual(h.registrations, ['open-log', 'open-preview']);
  const log = h.open('open-log', { scope: { kind: 'session', sessionId: 'task' } });
  const preview = h.open('open-preview', { scope: { kind: 'message', sessionId: 'task', messageClientId: 'row-7' } });
  assert.equal(log.openView.id, 'build-log'); assert.equal(log.openView.params.buildId, 'example-17');
  assert.equal(preview.openView.id, 'result-preview'); assert.equal(preview.openView.params.buildId, 'row-7');
  assert.deepEqual(Object.keys(log.openView), ['id', 'params']);
});
test('both shipped HTML pages consume the public snapshot and keep local interaction across positioning', async () => {
  for (const page of ['build-log', 'result-preview']) {
    const html = await readFile(new URL(`../../../../resources/system-skills/cindy-plugin-creator/examples/native-ui-reference/views/${page}.html`, import.meta.url), 'utf8');
    const script = await readFile(new URL(`../../../../resources/system-skills/cindy-plugin-creator/examples/native-ui-reference/views/${page}.js`, import.meta.url), 'utf8');
    assert.match(html, new RegExp(`<script src="${page}\\.js"></script>`));
    const nodes = new Map(['click', 'status', 'position'].map(id => [id, { textContent: '', addEventListener: (name, fn) => { nodes.get(id)[name] = fn; } }]));
    let changed;
    runInNewContext(script, {
      document: { getElementById: id => nodes.get(id) },
      window: { addEventListener() {}, cindy: { ui: { view: {
        read: async () => ({ scope: { kind: 'session', sessionId: 'task' }, params: { buildId: 'first' } }),
        onChanged: listener => { changed = listener; return () => {}; },
      } } } },
    });
    await Promise.resolve();
    assert.match(nodes.get('position').textContent, /first/);
    nodes.get('click').click();
    changed({ scope: { kind: 'session', sessionId: 'task' }, params: { buildId: 'second' } });
    assert.match(nodes.get('position').textContent, /second/);
    assert.equal(nodes.get('status').textContent, '此视图已点击 1 次');
  }
});
for (const withUi of [false, true]) test(`original tool remains available when UI is absent or unsupported (${withUi})`, async () => {
  const h = harness(withUi, []); await h.ready;
  assert.equal(h.registrations.length, 0);
  const result = await h.preview('old-task', 'hello');
  assert.equal(result.ok, true); assert.equal(result.result.format, 'plain'); assert.equal(result.result.preview, 'hello');
});
test('only the selected task changes and the original tool reads that value', async () => {
  const h = harness(); await h.ready; assert.equal(h.registrations[0], 'output-format');
  await h.render('task-a'); assert.equal(h.invalidations.length, 0);
  assert.equal((await h.action('task-a', 'markdown')).status, 'completed');
  assert.equal(h.invalidations[0].scope.sessionId, 'task-a');
  assert.equal((await h.preview('task-a', 'hello')).result.preview, '# Preview\n\nhello');
  assert.equal((await h.preview('task-b', 'hello')).result.format, 'plain');
});
test('invalid action or value leaves plugin state unchanged', async () => {
  const h = harness(); await h.ready;
  assert.equal((await h.action('task', 'future')).status, 'rejected');
  assert.equal((await h.action('task', 'markdown', 'other')).status, 'rejected');
  assert.equal(h.invalidations.length, 0);
  assert.equal((await h.preview('task', 'hello')).result.format, 'plain');
});
test('the optional statusbar click updates the same plugin value without requiring another outlet', async () => {
  const h = harness(true, ['session.statusbar']); await h.ready;
  assert.deepEqual(h.registrations, ['format-status']);
  assert.equal(h.render('task-a', 'format-status').controls[0].label, 'Output: plain · Switch');
  assert.equal((await h.action('task-a', undefined, 'toggle-format', 'format-status')).status, 'completed');
  assert.equal(h.render('task-a', 'format-status').controls[0].label, 'Output: markdown · Switch');
  assert.equal((await h.preview('task-a', 'hello')).result.format, 'markdown');
  assert.equal((await h.preview('task-b', 'hello')).result.format, 'plain');
  assert.equal(h.invalidations[0].scope.sessionId, 'task-a');
});
