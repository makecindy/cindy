/**
 * Unit: native preview must validate the resolved file before handing it to the OS.
 * Thumbnail tests exercise a different IPC consumer. A harmless-looking symlink
 * into a blocked directory is the minimal input that would disclose a protected file.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';

const io = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => ({ default: io }));
vi.mock('electron', () => ({ app: {} }));
vi.mock('../../filePathPolicy', async (original) => {
  const actual = await original<typeof import('../../filePathPolicy')>();
  return { ...actual, getSensitiveMediaBlocklist: () => [path.join(os.tmpdir(), 'protected')] };
});
import { openSystemPreview } from '../system-preview';

describe('native file preview', () => {
  it('rejects a link whose real file is blocked before reading or invoking the provider', async () => {
    const previewFile = vi.fn();
    const owner = { previewFile, isDestroyed: () => false } as unknown as BrowserWindow;
    io.realpath.mockResolvedValue(path.join(os.tmpdir(), 'protected', 'secret.pdf'));
    expect(await openSystemPreview(owner, path.join(os.tmpdir(), 'report.pdf'))).toBe(false);
    expect(io.stat).not.toHaveBeenCalled();
    expect(previewFile).not.toHaveBeenCalled();
  });
});
