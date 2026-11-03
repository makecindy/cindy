import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requireBundleDist } from '../scripts/bundle-dist.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'headless-bundle-dist-'));
  roots.push(root);
  const bundle = path.join(root, 'bundle');
  const dist = path.join(bundle, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'cli.cjs'), 'frozen-cli');
  await writeFile(path.join(dist, 'eval-cli.cjs'), 'frozen-eval');
  const digest = (text) => createHash('sha256').update(text).digest('hex');
  return { root, bundle, dist, manifest: { cliDigest: digest('frozen-cli'), evalCliDigest: digest('frozen-eval') } };
}

describe('release bundle dist binding', () => {
  it('accepts only the CLI files matching the frozen manifest', async () => {
    const f = await fixture();
    await expect(requireBundleDist(f.bundle, f.manifest)).resolves.toBe(f.dist);
  });
  it('rejects a missing bundle dist even when a development dist exists', async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, 'dist'));
    await writeFile(path.join(f.root, 'dist', 'cli.cjs'), 'unbound-development-cli');
    await rm(f.dist, { recursive: true });
    await expect(requireBundleDist(f.bundle, f.manifest)).rejects.toThrow();
  });
  it.each(['cli.cjs', 'eval-cli.cjs'])('rejects changed %s bytes', async (name) => {
    const f = await fixture();
    await writeFile(path.join(f.dist, name), 'tampered');
    await expect(requireBundleDist(f.bundle, f.manifest)).rejects.toThrow(/digest mismatch/);
  });
  it('rejects a partial bundle and a missing manifest digest', async () => {
    const f = await fixture();
    await expect(requireBundleDist(f.bundle, {})).rejects.toThrow(/digest mismatch/);
    await rm(path.join(f.dist, 'eval-cli.cjs'));
    await expect(requireBundleDist(f.bundle, f.manifest)).rejects.toThrow();
  });
});
