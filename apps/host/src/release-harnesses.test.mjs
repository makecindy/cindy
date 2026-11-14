// Protects the release harness selection used by scripts/build.mjs: which agent
// runtimes a standalone Host bundles, and that a bad selection fails before the
// build instead of shipping a release without an agent. Unit tier, no I/O.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RELEASE_HARNESSES, selectReleaseHarnesses } from './release-harnesses.mjs';

test('bundles every harness when nothing is selected', () => {
  for (const input of [{ env: {} }, { env: { CINDY_HOST_HARNESSES: '' } }]) {
    assert.deepEqual(selectReleaseHarnesses(input), { harnesses: [...RELEASE_HARNESSES], warnings: [] });
  }
});

test('--harnesses takes precedence over CINDY_HOST_HARNESSES', () => {
  const env = { CINDY_HOST_HARNESSES: 'claude-code-bin' };
  assert.deepEqual(selectReleaseHarnesses({ option: 'pi-bin, ripgrep-bin', env }).harnesses, ['pi-bin', 'ripgrep-bin']);
  assert.deepEqual(selectReleaseHarnesses({ env }).harnesses, ['claude-code-bin']);
});

test('rejects unknown or empty selections before any build work', () => {
  assert.throws(() => selectReleaseHarnesses({ option: 'pi-bin,pi', env: {} }), /Unknown harness: pi\. Choose from:/);
  assert.throws(() => selectReleaseHarnesses({ option: ' , ', env: {} }), /No harness selected/);
});

test('warns when Pi is bundled without the ripgrep it searches with', () => {
  assert.match(selectReleaseHarnesses({ option: 'pi-bin', env: {} }).warnings[0], /ripgrep-bin/);
  assert.deepEqual(selectReleaseHarnesses({ option: 'ripgrep-bin,pi-bin', env: {} }).warnings, []);
});
