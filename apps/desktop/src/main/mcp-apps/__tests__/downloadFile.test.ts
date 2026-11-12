import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const nativeReplace = vi.hoisted(() => vi.fn<(source: string, destination: string) => Promise<void>>());
vi.mock('../../windowsAtomicRename.js', () => ({ atomicReplaceWindowsDirectoryEntry: nativeReplace }));
import { saveAppDownload } from '../downloadFile.js';

// Draft ui/download-file. Tier: unit. Minimum missing cases: embedded bytes,
// a granted file stream, dialog cancellation, and a revoked View before publication.
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  nativeReplace.mockReset();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
// PR #7924 / 4420174702: saveAppDownload must replace a confirmed existing file.
// Unit: prior coverage only created a new target; minimum failure is rename EPERM/EEXIST.
// Real file contents and staging cleanup are verified; the Windows syscall is simulated.
it.each(['new', 'existing', 'EPERM', 'EEXIST'])('saves embedded text after the dialog confirms a sanitized name (%s)', async mode => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-app-download-')); roots.push(root);
  const destination = path.join(root, 'chosen.txt');
  if (mode !== 'new') await fs.writeFile(destination, 'previous contents');
  if (mode === 'EPERM' || mode === 'EEXIST') {
    nativeReplace.mockImplementation(async (source, target) => {
      await fs.copyFile(source, target);
      await fs.unlink(source);
    });
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('cannot overwrite'), { code: mode }));
  }
  const showSaveDialog = vi.fn(async () => destination);
  await saveAppDownload({ content: { type: 'resource', resource: { uri: 'file:///untrusted/NUL.txt', text: 'small' } },
    showSaveDialog, readGranted: vi.fn(), assertCurrent: async () => {}, signal: new AbortController().signal });
  expect(showSaveDialog).toHaveBeenCalledWith('download');
  expect(await fs.readFile(destination, 'utf8')).toBe('small');
  expect(await fs.readdir(root)).toEqual(['chosen.txt']);
});
it('does not read a ResourceLink after cancellation and does not publish after revocation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-app-download-')); roots.push(root);
  const abort = new AbortController();
  const readGranted = vi.fn(async () => new Response('owned'));
  const input = { content: { type: 'resource_link' as const, name: 'report.txt', uri: 'library:report.txt' },
    readGranted, assertCurrent: async () => {}, signal: abort.signal };
  expect(await saveAppDownload({ ...input, showSaveDialog: async () => null })).toEqual({ isError: true });
  expect(readGranted).not.toHaveBeenCalled();
  await expect(saveAppDownload({ ...input, showSaveDialog: async () => { abort.abort(); return path.join(root, 'report.txt'); } })).rejects.toThrow();
  expect(await fs.readdir(root)).toEqual([]);
});
