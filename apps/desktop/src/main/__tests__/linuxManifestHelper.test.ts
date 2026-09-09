import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface LinuxManifest {
  app: {
    version: string;
    installer?: { file: string; sha256: string; size: number };
    hotfix?: unknown;
    requireRelogin?: unknown;
  };
  installer?: unknown;
  claudeCode?: unknown;
}

function loadHelper() {
  const require = createRequire(import.meta.url);
  const helperPath = path.resolve(__dirname, '../../../scripts/ci/lib.mjs');
  const mod = require(helperPath) as {
    createLinuxFirstReleaseManifest: (
      version: string,
      baseManifest?: unknown,
      installer?: { file: string; sha256: string; size: number },
    ) => LinuxManifest;
  };
  return mod.createLinuxFirstReleaseManifest;
}

describe('createLinuxFirstReleaseManifest', () => {
  it('writes app.installer and never reintroduces hotfix or requireRelogin', () => {
    const createLinuxFirstReleaseManifest = loadHelper();
    const manifest = createLinuxFirstReleaseManifest(
      '0.0.2',
      {
        app: {
          version: '0.0.1',
          hotfix: { file: 'hotfix/linux-x64/old.zip', sha256: 'aa', size: 1 },
          requireRelogin: true,
          installer: { file: 'stale.deb', sha256: 'bb', size: 2 },
        },
        installer: { file: 'legacy.deb', sha256: 'cc', size: 3 },
        claudeCode: { version: '1.0.0', file: 'claude.gz', sha256: 'dd', size: 4 },
      },
      {
        file: 'app/linux-x64/cindy-0.0.2-amd64.deb',
        sha256: 'a'.repeat(64),
        size: 166_000_000,
      },
    );

    expect(manifest.app.version).toBe('0.0.2');
    expect(manifest.app.installer).toEqual({
      file: 'app/linux-x64/cindy-0.0.2-amd64.deb',
      sha256: 'a'.repeat(64),
      size: 166_000_000,
    });
    expect(manifest.app.hotfix).toBeUndefined();
    expect(manifest.app.requireRelogin).toBeUndefined();
    expect(manifest.installer).toBeUndefined();
    expect(manifest.claudeCode).toBeUndefined();
  });

  it('omits installer when metadata is missing instead of inventing an asset', () => {
    const createLinuxFirstReleaseManifest = loadHelper();
    const manifest = createLinuxFirstReleaseManifest('0.0.2');
    expect(manifest.app.version).toBe('0.0.2');
    expect(manifest.app.installer).toBeUndefined();
  });
});
