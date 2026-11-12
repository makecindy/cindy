import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn(), packaged: false }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged;
    },
    getAppPath: () => '/test-app',
  },
}));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => h.exec }));
import { linuxCredentialCommand, readLinuxUnlockState } from '../linuxCredentials';
afterEach(() => {
  vi.unstubAllGlobals();
  h.exec.mockReset();
  h.packaged = false;
});

it('launches the isolated helper with only public parent/profile arguments', () => {
  const command = linuxCredentialCommand('/test-profile');
  expect(command.file).toBe('/usr/bin/python3');
  expect(command.args).toEqual([
    '-I',
    '-B',
    '-u',
    path.join('/test-app', 'native', 'remote-desktop', 'linux-credentials', 'main.py'),
    '--serve',
    '/test-profile',
    String(process.pid),
    process.execPath,
  ]);
});
it('resolves the packaged helper outside asar', () => {
  h.packaged = true;
  vi.stubGlobal(
    'process',
    Object.assign(Object.create(process), { resourcesPath: '/test-resources' }),
  );
  expect(linuxCredentialCommand().args[3]).toBe(
    path.join('/test-resources', 'tools', 'remote-desktop', 'linux-credentials', 'main.py'),
  );
});
it.each(['locked', 'unlocked', 'unavailable', 'unexpected-private-detail'])(
  'only returns allowlisted status for %s',
  async (state) => {
    vi.stubGlobal(
      'process',
      Object.defineProperty(Object.create(process), 'platform', { value: 'linux' }),
    );
    h.exec.mockResolvedValue({ stdout: state + '\n' });
    expect(await readLinuxUnlockState()).toBe(
      ['locked', 'unlocked'].includes(state) ? state : 'unavailable',
    );
    expect(h.exec.mock.calls[0][1].at(-1)).toBe('--lock-state');
  },
);
it('treats missing helper dependencies as unsupported without leaking errors', async () => {
  vi.stubGlobal(
    'process',
    Object.defineProperty(Object.create(process), 'platform', { value: 'linux' }),
  );
  h.exec.mockRejectedValue(new Error('private diagnostic'));
  expect(await readLinuxUnlockState()).toBe('unavailable');
});
