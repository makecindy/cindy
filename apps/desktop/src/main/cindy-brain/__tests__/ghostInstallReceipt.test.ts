import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GhostInstallReceiptStore } from '../ghostInstallReceipt';

describe('GhostInstallReceiptStore cleanup', () => {
  let workDir: string;
  let stateRoot: string;
  let store: GhostInstallReceiptStore;

  beforeEach(async () => {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-receipt-cleanup-'));
    stateRoot = path.join(workDir, 'state');
    await fs.promises.mkdir(stateRoot);
    store = new GhostInstallReceiptStore(() => stateRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(workDir, { recursive: true, force: true });
  });

  it('removes a regular receipt and managed snapshot tree', async () => {
    const receipt = path.join(stateRoot, 'hello.json');
    const snapshot = path.join(stateRoot, 'skill-snapshots', 'hello', 'revision');
    await fs.promises.mkdir(snapshot, { recursive: true });
    await fs.promises.writeFile(receipt, '{}');
    await fs.promises.writeFile(path.join(snapshot, 'SKILL.md'), 'approved');

    await store.remove('hello');

    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'skill-snapshots', 'hello'))).toBe(false);
  });

  it('propagates transient snapshot-root IO failures so cleanup can be retried', async () => {
    const snapshotsRoot = path.join(stateRoot, 'skill-snapshots');
    const realLstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(snapshotsRoot)) {
        throw Object.assign(new Error('state root unreadable'), { code: 'EACCES' });
      }
      return realLstat(target, options as never);
    });

    await expect(store.remove('hello')).rejects.toThrow('state root unreadable');
  });

  it('propagates transient snapshot-root IO failures from synchronous recovery', () => {
    const snapshotsRoot = path.join(stateRoot, 'skill-snapshots');
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(snapshotsRoot)) {
        throw Object.assign(new Error('state root unreadable'), { code: 'EIO' });
      }
      return realLstatSync(target, options as never);
    });

    expect(() => store.removeSync('hello')).toThrow('state root unreadable');
  });

  it('rejects a linked snapshot root without touching its target', async () => {
    const external = path.join(workDir, 'external');
    const sentinel = path.join(external, 'hello', 'sentinel.txt');
    await fs.promises.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.promises.writeFile(sentinel, 'keep');
    try {
      await fs.promises.symlink(
        external,
        path.join(stateRoot, 'skill-snapshots'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }

    await expect(store.remove('hello')).rejects.toThrow(
      'skill snapshot path segment is not a real directory',
    );
    expect(await fs.promises.readFile(sentinel, 'utf8')).toBe('keep');
  });

  it('rejects a linked receipt instead of treating it as cleaned', async () => {
    const externalReceipt = path.join(workDir, 'external-receipt.json');
    await fs.promises.writeFile(externalReceipt, '{}');
    try {
      await fs.promises.symlink(externalReceipt, path.join(stateRoot, 'hello.json'), 'file');
    } catch {
      return;
    }

    await expect(store.remove('hello')).rejects.toThrow(
      'ghost receipt path is not a regular file',
    );
    expect(await fs.promises.readFile(externalReceipt, 'utf8')).toBe('{}');
  });
});
