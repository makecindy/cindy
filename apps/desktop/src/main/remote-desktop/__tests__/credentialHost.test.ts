import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/fake-profile' } }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
import { remoteCredentialHost } from '../credentialHost';

describe.runIf(process.platform === 'darwin')('credential helper Keychain wait', () => {
  let child: EventEmitter & {
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: { resume: ReturnType<typeof vi.fn> };
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  let requests: { id: string; method: string }[];
  function reply(result: unknown) {
    child.stdout.emit('data', JSON.stringify({ id: requests.at(-1)!.id, result }) + '\n');
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'process',
      Object.assign(Object.create(process), { resourcesPath: '/fake-resources' }),
    );
    requests = [];
    child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: { resume: vi.fn() },
      stdin: { write: vi.fn((line: string) => requests.push(JSON.parse(line))) },
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
  });
  afterEach(() => {
    remoteCredentialHost.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('allows setup approval past the old deadline but remains bounded', async () => {
    const setup = remoteCredentialHost.configure('global', 'owner', 'device', 'fake');
    const rejected = expect(setup).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(35_001);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('does not enqueue short background polls behind signing approval', async () => {
    const setup = remoteCredentialHost.configure('global', 'owner', 'device', 'fake');
    await vi.advanceTimersByTimeAsync(0);
    reply('descriptor');
    await setup;
    const opened = remoteCredentialHost.request(
      'peer',
      {
        op: 'credential',
        version: 1,
        kind: 'open',
        offer: 'fake-offer',
        descriptor: 'fake-descriptor',
      },
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    expect(requests.map((r) => r.method)).toEqual(['configure', 'begin']);
    expect(child.kill).not.toHaveBeenCalled();
    reply({ handle: 'handle', offer: 'offer' });
    await expect(opened).resolves.toEqual({ handle: 'handle', offer: 'offer' });
  });
});
