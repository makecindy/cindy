import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const profile = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => profile.root } }));
import { assertPrecreatedSessionNotCancelled, sealPrecreatedSessionCancellation, withPrecreatedSessionOperationLock } from '../precreatedCancellation';

describe('durable precreated cancellation', () => {
  beforeEach(() => { profile.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cancel-test-')); });
  afterEach(() => { fs.rmSync(profile.root, { recursive: true, force: true }); });

  it('survives module reload, is idempotent, and fences only the cancelled id', async () => {
    assertPrecreatedSessionNotCancelled('cancelled');
    sealPrecreatedSessionCancellation('cancelled');
    sealPrecreatedSessionCancellation('cancelled');
    vi.resetModules();
    const fresh = await import('../precreatedCancellation');
    expect(() => fresh.assertPrecreatedSessionNotCancelled('cancelled')).toThrow('PRECONDITION_FAILED');
    expect(() => fresh.assertPrecreatedSessionNotCancelled('other')).not.toThrow();
    expect(fs.readdirSync(path.join(profile.root, 'worktree-cancelled-creations'))).toHaveLength(1);
  });

  it('does not interpret a caller-controlled id as a path', () => {
    sealPrecreatedSessionCancellation('../../outside');
    const files = fs.readdirSync(path.join(profile.root, 'worktree-cancelled-creations'));
    expect(files).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });

  it('fails closed when the cancellation store is unreadable', async () => {
    fs.writeFileSync(path.join(profile.root, 'worktree-cancelled-creations'), 'not a directory');
    expect(() => assertPrecreatedSessionNotCancelled('id')).toThrow();
    expect(() => sealPrecreatedSessionCancellation('id')).toThrow();
    const operation = vi.fn(async () => {});
    await expect(withPrecreatedSessionOperationLock('id', operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
});
