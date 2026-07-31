import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverMarketplace } from '../sources/discover';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-discover-'));
  roots.push(root);
  return root;
}

function ghostJson(id: string, version = '1.0.0') {
  return JSON.stringify({
    schemaVersion: 2,
    id,
    name: `Plugin ${id}`,
    version,
    entry: 'main.js',
    slots: ['notify'],
  });
}

function writePlugin(root: string, rel: string, id: string, version = '1.0.0') {
  const dir = path.join(root, ...rel.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ghost.json'), ghostJson(id, version));
  fs.writeFileSync(path.join(dir, 'main.js'), '// entry');
}

function writeManifest(root: string, manifest: unknown, rel = '.agents/plugins/marketplace.json') {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
}

describe('discoverMarketplace', () => {
  it('discovers plugins from the primary manifest location', async () => {
    const root = makeRoot();
    writePlugin(root, 'plugins/alpha', 'alpha');
    writePlugin(root, 'plugins/beta', 'beta', '2.0.0');
    writeManifest(root, {
      name: 'team-market',
      interface: { displayName: 'Team Market' },
      plugins: [{ name: 'alpha', source: './plugins/alpha' }, { name: 'beta', source: 'plugins/beta' }],
    });

    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.name).toBe('team-market');
    expect(result.marketplace.displayName).toBe('Team Market');
    expect(result.marketplace.plugins.map((plugin) => plugin.ghostId)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(result.marketplace.plugins[1]?.version).toBe('2.0.0');
    expect(result.marketplace.skippedCount).toBe(0);
  });

  it.each([
    '.claude-plugin/marketplace.json',
    '.cursor-plugin/marketplace.json',
    '.agents/plugins/api_marketplace.json',
  ])('falls back to the alternate manifest location %s', async (rel) => {
    const root = makeRoot();
    writePlugin(root, 'p', 'solo');
    writeManifest(root, { name: 'alt', plugins: [{ name: 'solo', source: 'p' }] }, rel);
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.marketplace.name).toBe('alt');
  });

  it('prefers the primary manifest when several locations exist', async () => {
    const root = makeRoot();
    writePlugin(root, 'p', 'solo');
    writeManifest(root, { name: 'primary', plugins: [] });
    writeManifest(root, { name: 'secondary', plugins: [] }, '.claude-plugin/marketplace.json');
    const result = await discoverMarketplace(root);
    expect(result.ok && result.marketplace.name).toBe('primary');
  });

  it('supports the object form of local sources', async () => {
    const root = makeRoot();
    writePlugin(root, 'p', 'solo');
    writeManifest(root, {
      name: 'obj',
      plugins: [{ name: 'solo', source: { source: 'local', path: 'p' } }],
    });
    const result = await discoverMarketplace(root);
    expect(result.ok && result.marketplace.plugins).toHaveLength(1);
  });

  it('reports a missing manifest distinctly from a malformed one', async () => {
    const empty = makeRoot();
    expect(await discoverMarketplace(empty)).toEqual({ ok: false, code: 'MARKET_MANIFEST_MISSING' });

    const malformed = makeRoot();
    writeManifest(malformed, '{ not json');
    const result = await discoverMarketplace(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MARKET_SOURCE_INVALID');
  });

  it('skips unsupported remote plugin sources and invalid entries', async () => {
    const root = makeRoot();
    writePlugin(root, 'ok', 'good-one');
    writeManifest(root, {
      name: 'mixed',
      plugins: [
        { name: 'good', source: 'ok' },
        { name: 'remote', source: { source: 'url', url: 'https://x.test/r.git' } },
        { name: 'npm', source: { source: 'npm', package: '@x/y' } },
        { name: 'escapes', source: '../outside' },
        { name: 'absolute', source: '/etc/passwd' },
        { name: 'missing-ghost', source: 'nowhere' },
        'not-an-object',
      ],
    });
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.plugins.map((plugin) => plugin.ghostId)).toEqual(['good-one']);
    expect(result.marketplace.skippedCount).toBe(6);
  });

  it('skips plugins whose directory symlinks escape the market root', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    writePlugin(outside, 'escaped', 'escaped');
    writePlugin(root, 'plugins/good', 'good-one');
    fs.symlinkSync(outside, path.join(root, 'plugins', 'linked-out'), 'dir');
    writeManifest(root, {
      name: 'linked',
      plugins: [
        { name: 'good', source: 'plugins/good' },
        { name: 'escaped', source: 'plugins/linked-out/escaped' },
      ],
    });
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.plugins.map((plugin) => plugin.ghostId)).toEqual(['good-one']);
    expect(result.marketplace.skippedCount).toBe(1);
  });

  it('skips duplicate ghostIds keeping the first occurrence', async () => {
    const root = makeRoot();
    writePlugin(root, 'a', 'dup-id', '1.0.0');
    writePlugin(root, 'b', 'dup-id', '9.9.9');
    writeManifest(root, {
      name: 'dup',
      plugins: [{ name: 'a', source: 'a' }, { name: 'b', source: 'b' }],
    });
    const result = await discoverMarketplace(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marketplace.plugins).toHaveLength(1);
    expect(result.marketplace.plugins[0]?.version).toBe('1.0.0');
  });

  it('rejects manifests without a name or with a non-array plugins field', async () => {
    const root = makeRoot();
    writeManifest(root, { plugins: [] });
    expect((await discoverMarketplace(root)).ok).toBe(false);

    const root2 = makeRoot();
    writeManifest(root2, { name: 'x', plugins: {} });
    expect((await discoverMarketplace(root2)).ok).toBe(false);
  });
});
