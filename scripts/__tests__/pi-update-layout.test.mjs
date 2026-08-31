import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertPinnedRuntimeAsset,
  assetDigestMatchesUpstream,
  ensurePiThemeAssets,
  extractArchive,
  flattenExtractedDir,
  hasPiThemeAssets,
  readCachedAssetDigest,
} from '../../tools/pi/update.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-layout-'));
}

test('Pi updater accepts the flat Windows release layout', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'pi.exe');
  fs.writeFileSync(exe, Buffer.alloc(4096));
  fs.mkdirSync(path.join(dir, 'theme'));
  assert.equal(flattenExtractedDir(dir, 'pi.exe'), exe);
  assert.ok(fs.existsSync(path.join(dir, 'theme')));
});

test('Pi updater still flattens the nested Unix release layout', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, 'pi');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'pi'), Buffer.alloc(4096));
  fs.mkdirSync(path.join(nested, 'theme'));
  assert.equal(flattenExtractedDir(dir, 'pi'), path.join(dir, 'pi'));
  assert.ok(fs.statSync(path.join(dir, 'pi')).isFile());
  assert.ok(fs.statSync(path.join(dir, 'theme')).isDirectory());
});

test('Pi updater supplies fallback themes when an archive omits them', () => {
  const dir = tempDir();
  assert.equal(hasPiThemeAssets(dir), false);
  ensurePiThemeAssets(dir);
  assert.equal(hasPiThemeAssets(dir), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'theme', 'dark.json'), 'utf8')).name, 'dark');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'theme', 'light.json'), 'utf8')).name, 'light');

  fs.writeFileSync(path.join(dir, 'theme', 'dark.json'), '{"name":"custom"}');
  ensurePiThemeAssets(dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'theme', 'dark.json'), 'utf8')).name, 'custom');
});

test('Pi updater extracts tar.gz archives streamed to the system tar', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  fs.mkdirSync(path.join(inputDir, 'pi'), { recursive: true });
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(inputDir, 'pi', 'pi'), 'pi-fixture');

  const created = spawnSync('tar', ['-czf', 'fixture.tar.gz', '-C', 'input', 'pi'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr || created.error?.message);

  await extractArchive(path.join(root, 'fixture.tar.gz'), outputDir);

  assert.equal(fs.readFileSync(path.join(outputDir, 'pi', 'pi'), 'utf8'), 'pi-fixture');
});

test('Pi updater rejects unreadable archives through the returned promise', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, 'output');
  fs.mkdirSync(outputDir);

  await assert.rejects(
    extractArchive(path.join(root, 'missing.tar.gz'), outputDir),
    { code: 'ENOENT' },
  );
});

test('Pi updater rejects corrupt streamed archives', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'corrupt.tar.gz');
  const outputDir = path.join(root, 'output');
  // Keep the source multi-chunk so the pipeline also covers tar closing before all input is written.
  fs.writeFileSync(archive, Buffer.alloc(4 * 1024 * 1024, 0x61));
  fs.mkdirSync(outputDir);

  await assert.rejects(extractArchive(archive, outputDir));
});

test('Pi release pin covers every supported desktop architecture', () => {
  const pin = JSON.parse(fs.readFileSync(new URL('../../tools/pi/latest.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pin.runtimeAssets).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64',
  ]);
});

test('Pi updater re-verifies same-tag asset digest so a swapped upstream asset is not promoted from stale cache', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const digest = 'c'.repeat(64);
  fs.writeFileSync(path.join(dir, '.asset-digest.bin'), `sha256:${digest}\n`);

  // 读回归一化(容忍 sha256: 前缀 / 大小写 / 结尾换行)。
  assert.equal(readCachedAssetDigest(dir), digest);
  assert.equal(readCachedAssetDigest(tempDir()), null); // 无标记(旧缓存)→ null

  const asset = { digest: `sha256:${digest}` };
  assert.equal(assetDigestMatchesUpstream(readCachedAssetDigest(dir), asset), true);
  // 同 tag 资产被替换:上游 digest 变 → 不匹配,快速路径/跳过分支据此重下。
  assert.equal(assetDigestMatchesUpstream(readCachedAssetDigest(dir), { digest: `sha256:${'d'.repeat(64)}` }), false);
  // 缓存无标记 或 上游无 digest → 一律 false(fail-closed,重下核验)。
  assert.equal(assetDigestMatchesUpstream(null, asset), false);
  assert.equal(assetDigestMatchesUpstream(digest, { digest: undefined }), false);
});

test('Pi updater rejects mutable release metadata that differs from the reviewed pin', () => {
  const cache = {
    version: '1.2.3',
    runtimeAssets: {
      'darwin-arm64': { url: 'https://example.test/pi.tgz', sha256: 'a'.repeat(64) },
    },
  };
  const matching = {
    assets: [{
      name: 'pi-darwin-arm64.tar.gz',
      browser_download_url: 'https://example.test/pi.tgz',
      digest: `sha256:${'a'.repeat(64)}`,
    }],
  };
  assert.doesNotThrow(() => assertPinnedRuntimeAsset(
    cache, matching, '1.2.3', 'darwin-arm64', 'pi-darwin-arm64.tar.gz',
  ));
  const changed = structuredClone(matching);
  changed.assets[0].digest = `sha256:${'b'.repeat(64)}`;
  assert.throws(
    () => assertPinnedRuntimeAsset(cache, changed, '1.2.3', 'darwin-arm64', 'pi-darwin-arm64.tar.gz'),
    /does not match pin/,
  );
});
