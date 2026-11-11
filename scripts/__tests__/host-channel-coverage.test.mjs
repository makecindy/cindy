import assert from 'node:assert/strict';
import test from 'node:test';

import { classify, clientBehavior, moduleGroup, owningFile, rankUsage, summarize } from '../host-channel-coverage.mjs';

const main = (file) => `apps/desktop/src/main/${file}`;
const contract = new Set(['local-db:sessions:list']);
const owner = (registration) => classify(registration, contract).category;

test('classifies contract and client-mode channels before ownership', () => {
  assert.equal(owner({ channel: 'local-db:sessions:list', file: main('localDb/ipc/sessions.ts') }), 'contract');
  assert.equal(owner({ channel: 'host-client:retry', file: main('bootstrap-electron.ts'), enclosing: 'installHostClientMode' }), 'client');
});

test('ownership: B and C rules are final, A rules can turn into C through window API use', () => {
  assert.equal(owner({ channel: 'clipboard:copy-text', file: main('bootstrap-electron.ts'), gui: ['clipboard'] }), 'B');
  assert.equal(owner({ channel: 'anything', file: main('voice-input/index.ts') }), 'B');
  assert.equal(owner({ channel: 'ghost-page:pick-model', file: main('cindy-brain/x.ts'), perWebContents: true }), 'B');
  assert.equal(owner({ channel: 'terminal:create', file: main('maker-ipc/register.ts') }), 'C');
  assert.equal(owner({ channel: 'projects-root:choose', file: main('bootstrap-electron.ts') }), 'C');

  const plain = classify({ channel: 'maker:schedule:list', file: main('maker-ipc/register.ts'), gui: [] }, contract);
  assert.deepEqual([plain.category, plain.basis, plain.reason], ['A', 'rule', '自动化']);
  const both = classify({ channel: 'maker:schedule:export', file: main('maker-ipc/register.ts'), gui: ['dialog'] }, contract);
  assert.deepEqual([both.category, both.basis], ['C', 'dependency']);
  assert.match(both.reason, /自动化.*dialog/);

  assert.deepEqual(Object.values(pick(classify({ channel: 'billing:get-balance', file: main('billing/index.ts'), gui: [] }, contract))), ['A', 'default']);
  assert.deepEqual(Object.values(pick(classify({ channel: 'odd:thing', file: main('odd.ts'), gui: ['shell'] }, contract))), ['C', 'dependency']);
});

function pick({ category, basis }) {
  return { category, basis };
}

test('attributes package-defined channels to the desktop adapter that registers them', () => {
  const registration = { channel: 'feishuBot:status', file: 'packages/lizi-im/src/feishu/ipc.ts', registeredAt: `${main('im/host.ts')}:172` };
  assert.equal(owningFile(registration), main('im/host.ts'));
  assert.equal(moduleGroup(owningFile(registration)), 'im');
  assert.equal(owner(registration), 'A');
});

test('ranks A by every call in an embedded run and by unserved calls in a client run', () => {
  const inventory = {
    registrations: [
      { channel: 'local-db:sessions:list', kind: 'invoke', file: main('localDb/a.ts'), line: 1, gui: [] },
      { channel: 'maker:schedule:list', kind: 'invoke', file: main('maker-ipc/register.ts'), line: 2, gui: [] },
      { channel: 'git-context:get-for-session', kind: 'invoke', file: main('git-context/ipc.ts'), line: 3, gui: [] },
      { channel: 'clipboard:copy-text', kind: 'invoke', file: main('bootstrap-electron.ts'), line: 4, gui: [] },
    ],
    unresolved: [],
    contract,
  };
  const entry = (count, missing = 0, unsupported = 0) => ({ kind: 'invoke', count, handled: count - missing - unsupported, missing, unsupported });
  const channels = {
    'local-db:sessions:list': entry(9),
    'clipboard:copy-text': entry(8),
    'maker:schedule:list': entry(2, 0, 2),
    'git-context:get-for-session': entry(5),
  };
  const embedded = summarize(inventory, { mode: 'embedded', channels });
  assert.deepEqual(embedded.ranking.map((row) => [row.channel, row.count]), [['git-context:get-for-session', 5], ['maker:schedule:list', 2]]);
  assert.equal(embedded.usedTotals.A, 2);
  assert.equal(embedded.usedTotals.B, 1);
  assert.equal(embedded.usedTotals.aCalls, 7);

  const client = rankUsage(embedded.rows, { mode: 'client', channels });
  assert.deepEqual(client.map((row) => [row.channel, row.count]), [['maker:schedule:list', 2]]);
});

test('reports what a B channel does in client mode from the two handler snapshots', () => {
  const snapshot = (invoke, event = []) => ({ registered: { invoke, event } });
  const embedded = snapshot(['maker:computer:status', 'update-relaunch:blocking-summary', 'clipboard:copy-text'], ['maker:computer:drag']);
  const client = snapshot(['clipboard:copy-text']);
  const row = (channel, kind = 'invoke', extra = {}) => ({ channel, kind, ...extra });
  assert.equal(clientBehavior(row('clipboard:copy-text'), client, embedded), 'local');
  assert.equal(clientBehavior(row('maker:computer:status'), client, embedded), 'unsupported');
  assert.equal(clientBehavior(row('update-relaunch:blocking-summary'), client, embedded), 'no-handler');
  assert.equal(clientBehavior(row('maker:computer:drag', 'event'), client, embedded), 'dropped');
  assert.equal(clientBehavior(row('lazy:thing'), client, embedded), 'not-registered-either');
  assert.equal(clientBehavior(row('ghost-page:pick-model', 'invoke', { perWebContents: true }), client, embedded), 'per-webcontents');
  assert.equal(clientBehavior(row('clipboard:copy-text'), null, embedded), 'unknown');
});
