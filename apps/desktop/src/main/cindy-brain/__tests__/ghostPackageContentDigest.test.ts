import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ghostPackageContentDigest,
  installedGhostContentDigest,
  type GhostPackageContentEntry,
} from '../ghostPackageContentDigest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ghost-content-'));
  roots.push(root);
  return root;
}

function entry(filePath: string, relativePath: string): GhostPackageContentEntry {
  const bytes = fs.readFileSync(filePath);
  return {
    path: relativePath,
    bytes: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('installedGhostContentDigest', () => {
  it('matches the canonical package digest and ignores host-owned root files', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'ghost.json'), '{"id":"cindy-test"}');
    fs.writeFileSync(path.join(root, 'main.js'), 'export default 1;');
    fs.writeFileSync(path.join(root, 'assets', 'icon.txt'), 'icon');
    fs.writeFileSync(path.join(root, '.disabled'), '1');
    fs.writeFileSync(path.join(root, '.cindy-trust.json'), '{"trust":"local"}');

    const expected = ghostPackageContentDigest([
      entry(path.join(root, 'ghost.json'), 'ghost.json'),
      entry(path.join(root, 'main.js'), 'main.js'),
      entry(path.join(root, 'assets', 'icon.txt'), 'assets/icon.txt'),
    ]);
    expect(await installedGhostContentDigest(root)).toBe(expected);

    fs.writeFileSync(path.join(root, '.disabled'), '0');
    fs.writeFileSync(path.join(root, '.cindy-trust.json'), '{"trust":"official"}');
    expect(await installedGhostContentDigest(root)).toBe(expected);
  });

  it('changes when package bytes change', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'ghost.json'), '{}');
    fs.writeFileSync(path.join(root, 'main.js'), 'before');
    const before = await installedGhostContentDigest(root);

    fs.writeFileSync(path.join(root, 'main.js'), 'after');
    expect(await installedGhostContentDigest(root)).not.toBe(before);
  });

  it('fails closed when a package file is hard-linked', async () => {
    const root = tempRoot();
    const outside = path.join(tempRoot(), 'shared.js');
    fs.writeFileSync(outside, 'shared');
    fs.writeFileSync(path.join(root, 'ghost.json'), '{}');
    fs.linkSync(outside, path.join(root, 'main.js'));

    expect(await installedGhostContentDigest(root)).toBeNull();
  });
});
