import assert from 'node:assert/strict';
import test from 'node:test';

import { classify, moduleGroup, owningFile, rankUsage, summarize } from '../host-channel-coverage.mjs';

const main = (file) => `apps/desktop/src/main/${file}`;
const contract = new Set(['local-db:sessions:list']);

test('classifies contract, client-mode, window and backend channels', () => {
  assert.equal(classify({ channel: 'local-db:sessions:list', file: main('localDb/ipc/sessions.ts') }, contract).category, 'contract');
  assert.equal(classify({ channel: 'host-client:retry', file: main('bootstrap-electron.ts'), enclosing: 'installHostClientMode' }, contract).category, 'client');
  assert.equal(classify({ channel: 'clipboard:copy-text', file: main('bootstrap-electron.ts') }, contract).category, 'window');
  assert.equal(classify({ channel: 'anything', file: main('voice-input/index.ts') }, contract).category, 'window');
  assert.equal(classify({ channel: 'ghost-page:pick-model', file: main('cindy-brain/x.ts'), perWebContents: true }, contract).category, 'window');
  assert.equal(classify({ channel: 'maker:schedule:list', file: main('maker-ipc/register.ts') }, contract).category, 'backend');
});

test('attributes package-defined channels to the desktop adapter that registers them', () => {
  const registration = { channel: 'feishuBot:status', file: 'packages/lizi-im/src/feishu/ipc.ts', registeredAt: `${main('im/host.ts')}:172` };
  assert.equal(owningFile(registration), main('im/host.ts'));
  assert.equal(moduleGroup(owningFile(registration)), 'im');
  assert.equal(moduleGroup(main('bootstrap-electron.ts')), 'bootstrap-electron');
});

test('ranks only backend gaps, by every call in an embedded run and by unserved calls in a client run', () => {
  const inventory = {
    registrations: [
      { channel: 'local-db:sessions:list', kind: 'invoke', file: main('localDb/a.ts'), line: 1 },
      { channel: 'maker:schedule:list', kind: 'invoke', file: main('maker-ipc/register.ts'), line: 2 },
      { channel: 'git-context:get-for-session', kind: 'invoke', file: main('git-context/ipc.ts'), line: 3 },
      { channel: 'clipboard:copy-text', kind: 'invoke', file: main('bootstrap-electron.ts'), line: 4 },
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
  assert.deepEqual(embedded.usedTotals, { total: 4, contract: 1, client: 0, window: 1, backend: 2, unregistered: 0 });

  const client = rankUsage(embedded.rows, { mode: 'client', channels });
  assert.deepEqual(client.map((row) => [row.channel, row.count, row.outcome]), [['maker:schedule:list', 2, 'UNSUPPORTED_CAPABILITY']]);
});
