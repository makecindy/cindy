import { expect, it } from 'vitest';
import { supportsComposerDrag } from '../composerDrag.js';

// Unit: the Electron drag scenario can exercise only the running OS/version.
// Check the same decision Main uses to offer drag on verified desktop hosts.
it.each([
  ['win32', '42.11.12', true],
  ['darwin', '42.11.12', true],
  ['win32', '43.0.0', false],
  ['darwin', '43.0.0', false],
  ['linux', '42.11.12', false],
] as const)('composer drag on %s / Electron %s is enabled: %s', (platform, version, enabled) => {
  expect(supportsComposerDrag(platform, version)).toBe(enabled);
});
