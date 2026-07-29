import { describe, expect, it } from 'vitest';

import type { Manifest } from '../../manifestService.js';
import { getVendorAsset } from '../manifest.js';

function manifestWithVersion(version: string): Manifest {
  return {
    app: { version: 'test' },
    codex: {
      version,
      file: 'codex/darwin-arm64/codex.gz',
      sha256: 'a'.repeat(64),
      size: 1,
    },
  };
}

describe('getVendorAsset version path boundary', () => {
  it.each(['0.145.0', '2.1.219-beta.1', 'release_2026-07-27'])(
    'accepts a safe version segment: %s',
    (version) => {
      expect(getVendorAsset(manifestWithVersion(version), 'codex')?.version).toBe(version);
    },
  );

  it.each([
    '',
    '.',
    '..',
    '../outside',
    'nested/version',
    'nested\\version',
    '/absolute',
    `v${'1'.repeat(128)}`,
  ])('rejects a version that can escape or abuse the install directory: %s', (version) => {
    expect(getVendorAsset(manifestWithVersion(version), 'codex')).toBeUndefined();
  });
});
