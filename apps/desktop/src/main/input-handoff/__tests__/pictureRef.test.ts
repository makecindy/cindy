import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
});
