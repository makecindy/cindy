import assert from 'node:assert/strict';
import test from 'node:test';

import { checkSourceText } from '../check-ipc-channels.mjs';

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
