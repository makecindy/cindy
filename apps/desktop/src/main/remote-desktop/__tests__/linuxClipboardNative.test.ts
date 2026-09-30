import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn(), unlocked: vi.fn(), spawn: vi.fn() }));
vi.mock('../linuxSessionLock', () => ({ isLinuxDesktopUnlocked: h.unlocked }));
vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: h.spawn }));
vi.mock('node:util', () => ({ promisify: () => h.exec }));
vi.mock('node:fs', () => ({ accessSync: vi.fn(), constants: { X_OK: 1 } }));
import { readLinuxClipboardSnapshot, writeLinuxClipboard } from '../linuxClipboardNative';
beforeEach(() => {
  h.exec.mockReset();
  h.spawn.mockReset();
  h.unlocked.mockReset().mockResolvedValue(true);
  vi.stubGlobal('process', { ...process, platform: 'linux', resourcesPath: '/runtime' });
  vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', 'test');
});
it('refuses clipboard writes while locked without starting an owner', async () => {
  h.unlocked.mockResolvedValue(false);
  await expect(writeLinuxClipboard({ text: 'private' }, () => true)).rejects.toThrow(
    'DESKTOP_CLIPBOARD_UNAVAILABLE',
  );
  expect(h.spawn).not.toHaveBeenCalled();
});
it('kills the new clipboard owner if the compositor locks during its handshake', async () => {
  const stdout = new EventEmitter();
  const kill = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: { resume: vi.fn() },
    stdin: {
      on: vi.fn(),
      write: vi.fn(() => {
        h.unlocked.mockResolvedValue(false);
        stdout.emit('data', Buffer.from('ready\n'));
      }),
    },
    kill,
  });
  h.spawn.mockReturnValue(child);
  await expect(writeLinuxClipboard({ text: 'private' }, () => true)).rejects.toThrow(
    'DESKTOP_CLIPBOARD_UNAVAILABLE',
  );
  expect(kill).toHaveBeenCalledOnce();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it.each([false, true])('refuses clipboard reads when locked (primary=%s)', async (primary) => {
  h.unlocked.mockResolvedValue(false);
  await expect(readLinuxClipboardSnapshot(primary)).rejects.toThrow(
    'DESKTOP_CLIPBOARD_UNAVAILABLE',
  );
  expect(h.exec).not.toHaveBeenCalled();
});
it('discards clipboard content if the compositor locks during a native read', async () => {
  h.exec.mockImplementation(async () => {
    h.unlocked.mockResolvedValue(false);
    return { stdout: Buffer.from('private text') };
  });
  await expect(readLinuxClipboardSnapshot()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
});
it('reads all offered portable text alternatives while Cindy is unfocused', async () => {
  h.exec.mockImplementation(async (_tool, args: string[]) => ({
    stdout: Buffer.from(
      args.includes('--list-types')
        ? 'text/plain;charset=utf-8\ntext/html\ntext/rtf\n'
        : args.at(-1) === 'text/html'
          ? '<b>Hello</b>'
          : args.at(-1) === 'text/rtf'
            ? '{\\rtf1 Hello}'
            : 'Hello',
    ),
  }));
  expect((await readLinuxClipboardSnapshot()).content).toEqual({
    text: 'Hello',
    html: '<b>Hello</b>',
    rtf: '{\\rtf1 Hello}',
  });
});
it('does not read file-manager paths disguised as text or HTML', async () => {
  h.exec.mockResolvedValue({ stdout: Buffer.from('text/uri-list\ntext/plain\ntext/html\n') });
  expect((await readLinuxClipboardSnapshot()).content).toEqual({});
  expect(h.exec).toHaveBeenCalledOnce();
});
it('does not leak native clipboard diagnostics or confuse refusal with empty selection', async () => {
  h.exec.mockRejectedValue({
    stderr: Buffer.from('secret clipboard diagnostics'),
    stdout: Buffer.from('private text'),
  });
  await expect(readLinuxClipboardSnapshot()).rejects.toThrow('DESKTOP_CLIPBOARD_UNAVAILABLE');
  h.exec.mockRejectedValue({ stderr: Buffer.from('Nothing is copied') });
  expect((await readLinuxClipboardSnapshot()).content).toEqual({});
});
