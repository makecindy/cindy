import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_DEV_MAX_OLD_SPACE,
  withDesktopDevNodeOptions,
} from '../shared/desktop-dev-node-options.mjs';

test('adds the development heap headroom without dropping inherited options', () => {
  const result = withDesktopDevNodeOptions({ NODE_OPTIONS: '--trace-warnings' });

  assert.equal(
    result.NODE_OPTIONS,
    `--trace-warnings --max-old-space-size=${DESKTOP_DEV_MAX_OLD_SPACE}`,
  );
});

test('preserves an explicit max old-space setting', () => {
  const result = withDesktopDevNodeOptions({
    NODE_OPTIONS: '--max-old-space-size=4096 --trace-warnings',
  });

  assert.equal(result.NODE_OPTIONS, '--max-old-space-size=4096 --trace-warnings');
});

test('does not mutate the parent environment object', () => {
  const input = { NODE_OPTIONS: '' };
  const result = withDesktopDevNodeOptions(input);

  assert.equal(input.NODE_OPTIONS, '');
  assert.notEqual(result, input);
});
