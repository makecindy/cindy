import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ spawn: vi.fn(), probe: vi.fn(), command: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/test-profile' } }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));
vi.mock('../linuxCredentials', () => ({
  readLinuxUnlockState: h.probe,
  linuxCredentialCommand: h.command,
}));
import { remoteCredentialHost } from '../credentialHost';

beforeEach(() => {
  vi.stubGlobal(
    'process',
    Object.defineProperty(Object.create(process), 'platform', { value: 'linux' }),
  );
  h.probe.mockResolvedValue('unavailable');
  h.command.mockReturnValue({ file: '/test-python', args: ['--test-helper'] });
});
afterEach(() => {
  remoteCredentialHost.dispose();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('rejects unsupported Linux lockers before spawning or accessing identity storage', async () => {
  await expect(
    remoteCredentialHost.configure('global', 'account', 'host', 'test-token'),
  ).rejects.toThrow('CREDENTIAL_UNLOCK_UNAVAILABLE');
  expect(h.spawn).not.toHaveBeenCalled();
});
it('routes Linux configuration through the existing private helper lifecycle', async () => {
  h.probe.mockResolvedValue('locked');
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: { resume: vi.fn() },
    kill: vi.fn(),
    stdin: {
      write: vi.fn((line: string) => {
        const request = JSON.parse(line);
        queueMicrotask(() =>
          stdout.emit(
            'data',
            JSON.stringify({ id: request.id, result: 'test-public-descriptor' }) + '\n',
          ),
        );
      }),
    },
  });
  h.spawn.mockReturnValue(child);
  await expect(
    remoteCredentialHost.configure('global', 'account', 'host', 'test-token'),
  ).resolves.toBe('test-public-descriptor');
  expect(h.spawn).toHaveBeenCalledWith('/test-python', ['--test-helper'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  remoteCredentialHost.dispose();
  expect(child.kill).toHaveBeenCalledOnce();
});
