import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
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

  // 2026-11-25 real run: Cindy's browser screenshots are WebP and were refused ("PNG or JPEG"), and a path that
  // only exists where a remote agent runs got the same "pass a PNG or JPEG" message, hiding the real cause.
  // Entry: readHandoffPicture (the bytes go to the QR reader, which only decodes PNG/JPEG). Unit tier, real sharp.
  // Minimal failing input: a .webp in the task folder (was NOT_AN_IMAGE), and an absolute path that does not exist.
  it('hands WebP to the QR reader as PNG, and says when the file is not on this computer', async () => {
    const task = tempDir();
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).webp().toFile(path.join(task, 'shot.webp'));
    const authorize = vi.fn(async () => ({ allowed: true as const }));

    const webp = await readHandoffPicture('shot.webp', task, authorize as never);
    expect(webp.ok && webp.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const missing = await readHandoffPicture(path.join(task, 'elsewhere', 'shot.webp'), task, authorize as never);
    expect(missing).toMatchObject({ ok: false, errorCode: 'IMAGE_NOT_FOUND' });
    expect(!missing.ok && missing.message).toContain('on the computer running Cindy');

    // PR #12772 review (greptile, r4691724318): a folder Cindy may not read is not a missing file.
    const locked = path.join(task, 'locked');
    mkdirSync(locked);
    writeFileSync(path.join(locked, 'shot.png'), 'png');
    chmodSync(locked, 0o000);
    try {
      const denied = await readHandoffPicture(path.join(locked, 'shot.png'), task, authorize as never);
      expect(denied).toMatchObject({ ok: false, errorCode: 'IMAGE_NOT_FOUND' });
      expect(!denied.ok && denied.message).not.toContain('on the computer running Cindy');
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
