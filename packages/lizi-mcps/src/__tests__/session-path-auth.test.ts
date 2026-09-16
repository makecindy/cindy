import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  authorizedSessionPathStillBound,
  captureSessionPathAncestors,
  resolveCanonicalSessionPath,
  sameSessionPathAncestors,
} from '../session-path-auth.js';

const created: string[] = [];
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

describe('authorized session path ancestors', () => {
  it('captures the leaf and existing parents, and skips a missing write target', async () => {
    const root = await makeTempDir('cindy-path-auth-');
    const file = path.join(root, 'leaf.txt');
    await fs.writeFile(file, 'ok');
    const fileAncestors = await captureSessionPathAncestors(file);
    expect(fileAncestors?.[0]).toMatchObject({ path: file });
    expect(fileAncestors?.some((item) => item.path === root)).toBe(true);

    const missing = path.join(root, 'new.txt');
    const writeAncestors = await captureSessionPathAncestors(missing);
    expect(writeAncestors?.[0]).toMatchObject({ path: root });
    expect(writeAncestors?.some((item) => item.path === missing)).toBe(false);
  });

  it('rejects a parent swapped to a symlink after the grant identity was captured', async () => {
    const root = await makeTempDir('cindy-path-auth-swap-');
    const grantedDir = path.join(root, 'granted');
    const evilDir = path.join(root, 'evil');
    await fs.mkdir(grantedDir);
    await fs.mkdir(evilDir);
    const granted = path.join(grantedDir, 'input.txt');
    await fs.writeFile(granted, 'granted-bytes');
    await fs.writeFile(path.join(evilDir, 'input.txt'), 'evil-bytes');
    const before = await captureSessionPathAncestors(granted);
    expect(before).not.toBeNull();
    expect(await authorizedSessionPathStillBound(root, granted)).toBe(true);
    expect(await resolveCanonicalSessionPath(root, granted)).toBe(granted);

    await fs.rm(grantedDir, { recursive: true, force: true });
    await fs.symlink(evilDir, grantedDir, directoryLinkType);

    expect(await authorizedSessionPathStillBound(root, granted)).toBe(false);
    expect(await resolveCanonicalSessionPath(root, granted)).not.toBe(granted);
    const after = await captureSessionPathAncestors(granted);
    expect(after).toBeNull();
    expect(sameSessionPathAncestors(before ?? [], after ?? [])).toBe(false);
  });
});
