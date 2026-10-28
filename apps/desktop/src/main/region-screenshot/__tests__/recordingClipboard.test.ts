import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { copyRegionRecording } from '../recordingClipboard';
import { saveRegionRecording } from '../save';
import path from 'node:path';

const mock = vi.hoisted(() => ({
  exec: vi.fn(), put: vi.fn(), cleanup: vi.fn(), rollback: vi.fn(), current: vi.fn(),
  saveDialog: vi.fn(), write: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => 'videos' }, dialog: { showSaveDialog: mock.saveDialog, showMessageBox: vi.fn() } }));
vi.mock('node:fs/promises', () => ({ default: { writeFile: mock.write } }));
vi.mock('../../i18n', () => ({ t: (key: string) => key }));
vi.mock('node:child_process', () => ({ execFile: mock.exec }));
vi.mock('../../cindy-media/integrationCache', () => ({ integrationCachePut: mock.put }));
vi.mock('../../cindy-media/ledger', () => ({ removeRefsExceptHash: mock.cleanup }));
vi.mock('../../localDb/client/current', () => ({ getCurrentDbClientSnapshot: mock.current }));
vi.mock('../../device-link/broadcast-tap', () => ({ captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => true }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

const gif = new Uint8Array([...Buffer.from('GIF89a'), ...new Uint8Array(15), 0x3b]);
const db = {};
const owner = { client: { drizzle: db } };
const media = { absPath: "C:\\recordings\\a'b $x `name`.gif", hash: 'hash', rollbackRef: mock.rollback };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }));
  mock.current.mockReturnValue(owner);
  mock.put.mockResolvedValue(media);
  mock.cleanup.mockResolvedValue(1);
  mock.rollback.mockResolvedValue(undefined);
  mock.exec.mockImplementation((_file, _args, _options, callback) => callback(null));
});
afterEach(() => vi.unstubAllGlobals());

// User-requested clipboard export: saving tests cannot cover native file formats
// or retention after preview close. Production entry copyRegionRecording must
// retain verified bytes, publish a file list, then release only its previous ref.
// Minimal failures: invalid bytes, OS rejection, or owner replacement during ingest.
// Tier: unit; real validation and native-command builder, injected OS/storage I/O.
it('copies a retained file on Windows, escaping the path and cleaning old refs only after success', async () => {
  await copyRegionRecording(gif, 'gif', () => true);
  expect(mock.put).toHaveBeenCalledWith(expect.objectContaining({
    buffer: gif, mimeType: 'image/gif', isCache: false,
    cacheKey: 'recording-clipboard:latest', assertStillValid: expect.any(Function),
  }), db);
  expect(mock.exec).toHaveBeenCalledWith('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Set-Clipboard -LiteralPath 'C:\\recordings\\a''b $x `name`.gif'",
  ], expect.objectContaining({ windowsHide: true, timeout: 10_000 }), expect.any(Function));
  expect(mock.cleanup).toHaveBeenCalledWith({ refKind: 'integration-cache', refId: 'recording-clipboard:latest', keepHash: 'hash' }, db);
  expect(mock.exec.mock.invocationCallOrder[0]).toBeLessThan(mock.cleanup.mock.invocationCallOrder[0]);
  expect(mock.rollback).not.toHaveBeenCalled();
});

it('passes the macOS file path as an argument rather than AppleScript source', async () => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
  await copyRegionRecording(gif, 'gif', () => true);
  expect(mock.exec).toHaveBeenCalledWith('osascript', [
    '-e', 'on run argv', '-e', 'set the clipboard to (POSIX file (item 1 of argv))', '-e', 'end run', media.absPath,
  ], expect.any(Object), expect.any(Function));
});

it('rolls back only the failed copy reference and permits retry with the same clip', async () => {
  mock.exec.mockImplementationOnce((_file, _args, _options, callback) => callback(new Error('clipboard busy')));
  await expect(copyRegionRecording(gif, 'gif', () => true)).rejects.toThrow('clipboard busy');
  expect(mock.rollback).toHaveBeenCalledTimes(1);
  expect(mock.cleanup).not.toHaveBeenCalled();
  await copyRegionRecording(gif, 'gif', () => true);
  expect(mock.cleanup).toHaveBeenCalledTimes(1);
});

it.each(['owner', 'preview'])('rejects a late clipboard write after %s changes', async (change) => {
  let active = true;
  mock.put.mockImplementationOnce(async () => {
    if (change === 'owner') mock.current.mockReturnValue({ ...owner });
    else active = false;
    return media;
  });
  await expect(copyRegionRecording(gif, 'gif', () => active)).rejects.toThrow('cancelled');
  expect(mock.exec).not.toHaveBeenCalled();
  expect(mock.rollback).toHaveBeenCalledTimes(1);
  expect(mock.cleanup).not.toHaveBeenCalled();
});

it('rejects invalid media before storage or clipboard access', async () => {
  await expect(copyRegionRecording(gif, 'webm', () => true)).rejects.toThrow('Invalid recording');
  await expect(copyRegionRecording(new Uint8Array(20), 'gif', () => true)).rejects.toThrow('Invalid recording');
  expect(mock.put).not.toHaveBeenCalled();
  expect(mock.exec).not.toHaveBeenCalled();
});

it('keeps successful clipboard bytes referenced if old-reference cleanup fails', async () => {
  mock.cleanup.mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(copyRegionRecording(gif, 'gif', () => true)).resolves.toBeUndefined();
  expect(mock.rollback).not.toHaveBeenCalled();
});

// PR #7300 owner boundary: clipboard tests do not cover the native save dialog.
// Unit, real save entry: invalidate while the dialog is pending; no old clip may
// be written to the newly selected path. Reuse this export suite and fake only I/O.
it('cancels recording export when ownership changes before the save dialog returns', async () => {
  let current = true;
  const filePath = path.join('recordings', 'clip.gif');
  mock.saveDialog.mockImplementationOnce(async () => {
    current = false;
    return { canceled: false, filePath };
  });
  expect(await saveRegionRecording(gif, 'gif', () => current)).toBe(false);
  expect(mock.write).not.toHaveBeenCalled();
  expect(await saveRegionRecording(gif, 'gif', () => current)).toBe(false);
  expect(mock.saveDialog).toHaveBeenCalledTimes(1);
  current = true;
  mock.saveDialog.mockResolvedValueOnce({ canceled: false, filePath });
  expect(await saveRegionRecording(gif, 'gif', () => current)).toBe(true);
  expect(mock.write).toHaveBeenCalledExactlyOnceWith(filePath, gif);
});
