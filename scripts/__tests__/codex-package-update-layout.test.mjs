import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_PACKAGE_PLATFORMS,
  assertPinnedRuntimeAsset,
  assetDigestMatchesUpstream,
  extractArchive,
  isTargetLockError,
  readCachedAssetDigest,
  validateCodexPackageDirectory,
} from '../../tools/codex-package/update.mjs';

const VERSION = '1.2.3';
const WINDOWS_PLATFORM = CODEX_PACKAGE_PLATFORMS.find((platform) => platform.key === 'win32-x64');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-package-test-'));
}

function writePackageFixture(root, overrides = {}) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'codex-path'), { recursive: true });
  fs.mkdirSync(path.join(root, 'codex-resources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'codex.exe'), 'codex');
  fs.writeFileSync(path.join(root, 'bin', 'codex-code-mode-host.exe'), 'code-mode');
  fs.writeFileSync(path.join(root, 'codex-path', 'rg.exe'), 'rg');
  fs.writeFileSync(path.join(root, 'codex-resources', 'codex-command-runner.exe'), 'runner');
  fs.writeFileSync(path.join(root, 'codex-resources', 'codex-windows-sandbox-setup.exe'), 'sandbox');
  const manifest = {
    layoutVersion: 1,
    version: VERSION,
    target: WINDOWS_PLATFORM.target,
    variant: 'codex',
    entrypoint: WINDOWS_PLATFORM.entrypoint,
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path',
    ...overrides,
  };
  fs.writeFileSync(path.join(root, 'codex-package.json'), JSON.stringify(manifest, null, 2));
}

test('Codex package updater validates the complete official package layout', (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePackageFixture(root);

  const validated = validateCodexPackageDirectory(root, {
    version: VERSION,
    target: WINDOWS_PLATFORM.target,
    entrypoint: WINDOWS_PLATFORM.entrypoint,
  });

  assert.equal(validated.manifest.variant, 'codex');
  assert.equal(validated.entrypointPath, path.join(root, 'bin', 'codex.exe'));
  assert.equal(validated.codeModeHostPath, path.join(root, 'bin', 'codex-code-mode-host.exe'));
  assert.equal(validated.ripgrepPath, path.join(root, 'codex-path', 'rg.exe'));
});

test('Codex package updater rejects the app-server-only variant and incomplete packages', (t) => {
  const wrongVariant = tempDir();
  const missingSidecar = tempDir();
  t.after(() => fs.rmSync(wrongVariant, { recursive: true, force: true }));
  t.after(() => fs.rmSync(missingSidecar, { recursive: true, force: true }));

  writePackageFixture(wrongVariant, { variant: 'codex-app-server' });
  assert.throws(
    () => validateCodexPackageDirectory(wrongVariant, {
      version: VERSION,
      target: WINDOWS_PLATFORM.target,
      entrypoint: WINDOWS_PLATFORM.entrypoint,
    }),
    /variant mismatch/,
  );

  writePackageFixture(missingSidecar);
  fs.rmSync(path.join(missingSidecar, 'bin', 'codex-code-mode-host.exe'));
  assert.throws(
    () => validateCodexPackageDirectory(missingSidecar, {
      version: VERSION,
      target: WINDOWS_PLATFORM.target,
      entrypoint: WINDOWS_PLATFORM.entrypoint,
    }),
    /required file missing/,
  );
});

test('Codex package updater extracts flat tar.gz packages through the system tar', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  fs.mkdirSync(inputDir);
  fs.mkdirSync(outputDir);
  writePackageFixture(inputDir);

  const created = spawnSync('tar', ['-czf', 'fixture.tar.gz', '-C', 'input', '.'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr || created.error?.message);

  await extractArchive(path.join(root, 'fixture.tar.gz'), outputDir);
  const validated = validateCodexPackageDirectory(outputDir, {
    version: VERSION,
    target: WINDOWS_PLATFORM.target,
    entrypoint: WINDOWS_PLATFORM.entrypoint,
  });
  assert.equal(fs.readFileSync(validated.entrypointPath, 'utf8'), 'codex');
});

test('Codex package pin covers every official desktop target and preserves entrypoint metadata', () => {
  const pin = JSON.parse(fs.readFileSync(new URL('../../tools/codex-package/latest.json', import.meta.url), 'utf8'));
  assert.equal(pin.layoutVersion, 1);
  assert.equal(pin.variant, 'codex');
  assert.deepEqual(
    Object.keys(pin.runtimeAssets).sort(),
    CODEX_PACKAGE_PLATFORMS.map((platform) => platform.key).sort(),
  );
  for (const platform of CODEX_PACKAGE_PLATFORMS) {
    const asset = pin.runtimeAssets[platform.key];
    assert.equal(asset.target, platform.target);
    assert.equal(asset.entrypoint, platform.entrypoint);
    assert.equal(asset.url.endsWith('/' + platform.asset), true);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.equal(asset.size > 0, true);
  }
});

test('Codex package updater rejects release metadata that differs from the reviewed pin', () => {
  const platform = WINDOWS_PLATFORM;
  const digest = 'a'.repeat(64);
  const url = 'https://example.test/codex-package.tar.gz';
  const cache = {
    version: VERSION,
    layoutVersion: 1,
    variant: 'codex',
    runtimeAssets: {
      [platform.key]: {
        url,
        sha256: digest,
        target: platform.target,
        entrypoint: platform.entrypoint,
      },
    },
  };
  const metadata = {
    assets: [{ name: platform.asset, browser_download_url: url, digest: 'sha256:' + digest }],
  };

  assert.doesNotThrow(() => assertPinnedRuntimeAsset(cache, metadata, VERSION, platform));
  const changed = structuredClone(metadata);
  changed.assets[0].digest = 'sha256:' + 'b'.repeat(64);
  assert.throws(
    () => assertPinnedRuntimeAsset(cache, changed, VERSION, platform),
    /digest does not match pin/,
  );
});

test('Codex package updater normalizes cached release asset digests', (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const digest = 'c'.repeat(64);
  fs.writeFileSync(path.join(root, '.asset-digest.bin'), 'sha256:' + digest.toUpperCase() + '\n');

  assert.equal(readCachedAssetDigest(root), digest);
  assert.equal(assetDigestMatchesUpstream(digest, { digest: 'sha256:' + digest }), true);
  assert.equal(assetDigestMatchesUpstream(digest, { digest: 'sha256:' + 'd'.repeat(64) }), false);
});

test('Codex package updater treats locked promotion targets as failures', () => {
  for (const code of ['EBUSY', 'ETXTBSY', 'EPERM']) {
    assert.equal(isTargetLockError(Object.assign(new Error('locked'), { code })), true);
  }
  assert.equal(isTargetLockError(Object.assign(new Error('missing'), { code: 'ENOENT' })), false);
});
