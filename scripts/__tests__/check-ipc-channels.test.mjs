import assert from 'node:assert/strict';
import test from 'node:test';

import { checkSourceText, loadKnownChannels } from '../check-ipc-channels.mjs';

test('channel table guard unwraps as, satisfies, and parenthesized expressions', () => {
  const errors = checkSourceText('fixture.ts', `
type ChannelMap = Record<string, string>;

const AS_CHANNELS = {
  LIST: 'review:as-expression',
} as const;

const SATISFIES_CHANNELS = ({
  LIST: 'review:satisfies-expression',
} satisfies ChannelMap);

const PAREN_CHANNELS = (({
  LIST: 'review:parenthesized-expression',
}));
`);

  assert.deepEqual(
    errors.map((error) => error.channel),
    [
      'review:as-expression',
      'review:satisfies-expression',
      'review:parenthesized-expression',
    ],
  );
});

test('channel table guard descends into new Set and freeze-style wrappers', () => {
  const errors = checkSourceText('fixture.ts', `
const SET_CHANNELS: ReadonlySet<string> = new Set([
  'review:set-member',
  KNOWN_CONSTANT,
]);

const FROZEN_CHANNELS = Object.freeze(['review:frozen-member'] as const);
`);

  assert.deepEqual(
    errors.map((error) => error.channel),
    ['review:set-member', 'review:frozen-member'],
  );
});

test('broadcastToAllWindows counts as a low-level fan-out wrapper', () => {
  const errors = checkSourceText('fixture.ts', `
broadcastToAllWindows('review:broadcast', payload);
broadcastToAllWindows(IPC_CHANNELS.REVIEW.BROADCAST, payload);
`);

  assert.deepEqual(errors.map((error) => error.channel), ['review:broadcast']);
});

test('known channel literals are flagged in any position, once per literal', () => {
  const known = new Set(['review:known', 'review:known-key']);
  const errors = checkSourceText('fixture.ts', `
const TIMEOUT_OVERRIDES_MS = {
  'review:known-key': 40_000,
  'review:unknown-key': 1_000,
};

invokeRemote(deviceId, 'review:known', args);
ipcRenderer.invoke('review:known');
`, known);

  assert.deepEqual(
    errors.map((error) => [error.call, error.channel]),
    [
      ['channel literal', 'review:known-key'],
      ['channel literal', 'review:known'],
      ['ipcRenderer.invoke', 'review:known'],
    ],
  );
});

test('loadKnownChannels reads the cindy-ipc channel tables', () => {
  const known = loadKnownChannels();
  assert.ok(known.has('desktop-cmd:run'));
  assert.ok(known.has('worktree:create'));
  assert.ok(!known.has('not-a-channel'));
});
