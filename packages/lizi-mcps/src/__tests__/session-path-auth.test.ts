import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  authorizeSessionPathWithPinnedAncestors,
  authorizedSessionPathStillBound,
  captureSessionPathAncestors,
  grantedSessionPathAncestorsStillMatch,
  grantedSessionPathAncestorsStillPresent,
  resolveCanonicalSessionPath,
  sameSessionPathAncestors,
  setSessionPathAuthorizer,
} from '../session-path-auth.js';

const created: string[] = [];
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

afterEach(async () => {
  setSessionPathAuthorizer(undefined);
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

  it('sameSessionPathAncestors requires the same path and inode identity', async () => {
    const root = await makeTempDir('cindy-path-auth-same-');
    const file = path.join(root, 'leaf.txt');
    await fs.writeFile(file, 'ok');
    const first = await captureSessionPathAncestors(file);
    const second = await captureSessionPathAncestors(file);
    expect(first).not.toBeNull();
    expect(sameSessionPathAncestors(first ?? [], second ?? [])).toBe(true);
    expect(sameSessionPathAncestors(first ?? [], [])).toBe(false);
    expect(sameSessionPathAncestors([], first ?? [])).toBe(false);
    expect(sameSessionPathAncestors(first ?? [], [{
      path: file,
      dev: 0n,
      ino: 0n,
    }, ...(first?.slice(1) ?? [])])).toBe(false);
  });

  it('rejects a regular file swapped in while the confirm card is up', async () => {
    const root = await makeTempDir('cindy-path-auth-during-');
    const file = path.join(root, 'input.txt');
    await fs.writeFile(file, 'granted');
    setSessionPathAuthorizer(async () => {
      await fs.rm(file);
      await fs.writeFile(file, 'evil');
      return { allowed: true, isCurrent: () => true };
    });
    const result = await authorizeSessionPathWithPinnedAncestors({
      workingDir: root,
      path: file,
      toolName: 'cindy-docs',
      operation: 'read',
    });
    expect(result).toMatchObject({ allowed: false });
    if (!result.allowed) expect(result.reason).toContain('确认期间');
  });

  it('rejects a parent directory replaced by another regular directory during authorization', async () => {
    const root = await makeTempDir('cindy-path-auth-parent-');
    const grantedDir = path.join(root, 'granted');
    const evilDir = path.join(root, 'evil');
    await fs.mkdir(grantedDir);
    await fs.mkdir(evilDir);
    const file = path.join(grantedDir, 'input.txt');
    await fs.writeFile(file, 'granted');
    await fs.writeFile(path.join(evilDir, 'input.txt'), 'evil');
    setSessionPathAuthorizer(async () => {
      await fs.rm(grantedDir, { recursive: true, force: true });
      await fs.rename(evilDir, grantedDir);
      return { allowed: true, isCurrent: () => true };
    });
    const result = await authorizeSessionPathWithPinnedAncestors({
      workingDir: root,
      path: file,
      toolName: 'cindy-docs',
      operation: 'read',
    });
    expect(result.allowed).toBe(false);
  });

  it('allows a write target that appears under the same granted parents', async () => {
    const root = await makeTempDir('cindy-path-auth-write-');
    const file = path.join(root, 'new.txt');
    const before = await captureSessionPathAncestors(file);
    expect(before?.[0]?.path).toBe(root);
    setSessionPathAuthorizer(async () => {
      await fs.writeFile(file, 'now-exists');
      return { allowed: true, isCurrent: () => true };
    });
    const result = await authorizeSessionPathWithPinnedAncestors({
      workingDir: root,
      path: file,
      toolName: 'cindy-docs',
      operation: 'write',
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(grantedSessionPathAncestorsStillMatch(before ?? [], result.authorizedAncestors, file)).toBe(true);
      expect(grantedSessionPathAncestorsStillPresent(before ?? [], result.authorizedAncestors)).toBe(true);
    }
  });

  it('stillPresent allows a newly created leaf and rejects a parent inode swap', async () => {
    const root = await makeTempDir('cindy-path-auth-present-');
    const grantedDir = path.join(root, 'granted');
    const evilDir = path.join(root, 'evil');
    await fs.mkdir(grantedDir);
    await fs.mkdir(evilDir);
    const missing = path.join(grantedDir, 'new.txt');
    const before = await captureSessionPathAncestors(missing);
    expect(before?.[0]?.path).toBe(grantedDir);
    await fs.writeFile(missing, 'now-exists');
    const afterCreate = await captureSessionPathAncestors(missing);
    expect(grantedSessionPathAncestorsStillPresent(before ?? [], afterCreate ?? [])).toBe(true);

    await fs.rm(grantedDir, { recursive: true, force: true });
    await fs.rename(evilDir, grantedDir);
    const afterSwap = await captureSessionPathAncestors(path.join(grantedDir, 'new.txt'));
    expect(grantedSessionPathAncestorsStillPresent(before ?? [], afterSwap ?? [])).toBe(false);
  });
});
