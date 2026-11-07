import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHandoffPicture } from '../pictureRef.js';

// PR #8083 review: ask_owner(kind="scan") must not read a file outside the task
// folder without the task's file grant (media.import_image applies the same rule).
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-handoff-picture-test-'));
  dirs.push(dir);
  return dir;
}

describe('代输入 screenshot read', () => {
  it('reads a picture in the task folder without asking, and asks before one outside it', async () => {
    const task = tempDir();
    const elsewhere = tempDir();
    writeFileSync(path.join(task, 'shot.png'), 'inside');
    writeFileSync(path.join(elsewhere, 'shot.png'), 'outside');
    const authorize = vi.fn(async () => ({ allowed: false as const, reason: 'Not granted for this task.' }));

    const inside = await readHandoffPicture('shot.png', task, authorize);
    expect(inside.ok && inside.bytes.toString()).toBe('inside');
    const localUrl = pathToFileURL(path.join(task, 'shot.png')).href;
    expect(await readHandoffPicture(localUrl, task, authorize)).toEqual({ ok: true, bytes: Buffer.from('inside') });
    expect(authorize).not.toHaveBeenCalled();

    const outside = await readHandoffPicture(path.join(elsewhere, 'shot.png'), task, authorize);
    expect(outside).toEqual({ ok: false, errorCode: 'PERMISSION_DENIED', message: 'Not granted for this task.' });
    expect(authorize).toHaveBeenCalledTimes(1);

    // A relative path climbing out of the task folder is outside too.
    authorize.mockResolvedValueOnce({ allowed: true } as never);
    const granted = await readHandoffPicture(path.relative(task, path.join(elsewhere, 'shot.png')), task, authorize);
    expect(granted.ok && granted.bytes.toString()).toBe('outside');
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it('accepts a real local WebP only when the avatar reader opts in', async () => {
    const sharp = (await import('sharp')).default;
    const task = tempDir();
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 } } }).webp().toBuffer();
    writeFileSync(path.join(task, 'avatar.webp'), bytes);
    const authorize = vi.fn(async () => ({ allowed: true as const }));
    expect(await readHandoffPicture('avatar.webp', task, authorize)).toMatchObject({ ok: false, errorCode: 'NOT_AN_IMAGE' });
    expect(await readHandoffPicture('avatar.webp', task, authorize, { allowWebp: true, maxBytes: bytes.length - 1 }))
      .toMatchObject({ ok: false, errorCode: 'IMAGE_NOT_FOUND' });
    expect(await readHandoffPicture('avatar.webp', task, authorize, { allowWebp: true, maxBytes: bytes.length }))
      .toEqual({ ok: true, bytes });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('does not read an outside file swapped in after path authorization', async () => {
    const task = tempDir();
    const parent = tempDir();
    const grantedDir = path.join(parent, 'authorized');
    const privateDir = tempDir();
    const grantedPath = path.join(grantedDir, 'avatar.png');
    const privatePath = path.join(privateDir, 'avatar.png');
    mkdirSync(grantedDir);
    writeFileSync(grantedPath, 'authorized');
    writeFileSync(privatePath, 'private');
    const authorize = vi.fn(async () => {
      rmSync(grantedDir, { recursive: true });
      symlinkSync(privateDir, grantedDir, process.platform === 'win32' ? 'junction' : 'dir');
      return { allowed: true as const };
    });
    const result = await readHandoffPicture(grantedPath, task, authorize, { allowWebp: true });
    expect(authorize).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });

  it('rejects an outside file when its grant expires before or during the read', async () => {
    const task = tempDir();
    const outside = path.join(tempDir(), 'avatar.png');
    writeFileSync(outside, 'authorized');
    const isCurrent = vi.fn().mockReturnValueOnce(false);
    expect(await readHandoffPicture(outside, task, async () => ({ allowed: true, isCurrent })))
      .toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(isCurrent).toHaveBeenCalledOnce();

    const expiresDuringRead = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await readHandoffPicture(outside, task, async () => ({ allowed: true, isCurrent: expiresDuringRead })))
      .toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(expiresDuringRead).toHaveBeenCalledTimes(2);
  });
});
