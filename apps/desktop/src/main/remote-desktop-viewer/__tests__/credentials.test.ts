import { beforeEach, expect, it, vi } from 'vitest';
import { ViewerCredentials } from '../credentials';

const native = vi.hoisted(() => ({ call: vi.fn(), dispose: vi.fn() }));
vi.mock('../../remote-desktop/credentialHost', () => ({
  RemoteCredentialHost: class {
    viewerCall = native.call;
    dispose = native.dispose;
  },
  remoteCredentialHost: {
    currentToken: () => ({
      realm: 'global',
      membership: 'owner',
      authDevice: 'local',
      token: 'test-token',
    }),
  },
}));
vi.mock('../../i18n', () => ({ getResolvedMainLocale: () => 'en' }));
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false } }));
beforeEach(() => {
  vi.resetAllMocks();
});
const mac = it.runIf(process.platform === 'darwin');
mac.each(['unlocked', 'unknown'])('does not authenticate when host state is %s', async (state) => {
  native.call.mockResolvedValue({ autoUnlock: true });
  const request = vi.fn(async () => ({ version: 1, state })) as any;
  const credentials = new ViewerCredentials({ request });
  await credentials.run('target', 'darwin', 'unlock', undefined, () => {});
  expect(request).toHaveBeenCalledTimes(1);
  expect(native.call.mock.calls.map((call) => call[1])).toEqual(['viewerSettings']);
});
mac(
  'preserves a disabled biometric preference when reenabling and never receives a password',
  async () => {
    let receives = 0;
    native.call.mockImplementation(async (_realm, method, args) => {
      if (method === 'viewerSettings')
        return { autoUnlock: false, biometricAvailable: true, biometricPreferred: false };
      if (method === 'viewerBegin') {
        expect(args.biometric).toBe(false);
        return { handle: 'local', offer: 'encrypted-offer', descriptor: 'public-local' };
      }
      if (method === 'viewerReceive')
        return JSON.stringify(
          ++receives === 1 ? { kind: 'ready' } : { kind: 'authenticated', accepted: true },
        );
      if (method === 'viewerPassword') return 'ciphertext-only';
      if (method === 'viewerEnd') return '';
      return 'encrypted-ready';
    });
    const request = vi.fn(async (message: any) => {
      if (message.kind === 'prepare') {
        expect(message.setup).toBe(true);
        return { version: 1, ready: true, descriptor: 'public-host' };
      }
      if (message.kind === 'open') return { handle: 'remote', offer: 'encrypted-offer' };
      return { ciphertext: 'encrypted-reply' };
    }) as any;
    await new ViewerCredentials({ request }).run('target', 'darwin', 'enable', undefined, () => {});
    expect(
      request.mock.calls.some(([message]: any[]) => message.ciphertext === 'ciphertext-only'),
    ).toBe(true);
    expect(native.call.mock.calls.filter((call) => call[1] === 'viewerPassword')).toHaveLength(1);
  },
);
mac('cancels native preparation before it can send a late credential offer', async () => {
  let finish!: () => void;
  native.call.mockImplementation(async (_realm, method) =>
    method === 'viewerSettings'
      ? {}
      : new Promise<void>((resolve) => {
          finish = resolve;
        }),
  );
  const request = vi.fn(async () => ({
    version: 1,
    ready: true,
    descriptor: 'public-host',
  })) as any;
  const credentials = new ViewerCredentials({ request });
  const pending = credentials.run('target', 'darwin', 'enable', undefined, () => {});
  const rejected = expect(pending).rejects.toThrow('CREDENTIAL_CANCELLED');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  credentials.dispose();
  finish();
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
  expect(native.dispose).toHaveBeenCalledOnce();
});

mac.each(['status', 'prepare', 'open', 'exchange', 'cleanup'])(
  'releases cancelled authentication during %s without releasing its replacement',
  async (stage) => {
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    let cleanup = false;
    native.call.mockImplementation(async (_realm, method, args) => {
      if (method === 'viewerSettings') {
        if (args.target === 'replacement')
          return new Promise((resolve) => {
            finishNew = resolve;
          });
        return { autoUnlock: true };
      }
      if (method === 'viewerBegin')
        return { handle: 'local', offer: 'offer', descriptor: 'descriptor' };
      if (method === 'viewerReceive') return JSON.stringify({ kind: 'ready' });
      if (method === 'viewerPassword') throw new Error('CREDENTIAL_PASSWORD_REJECTED');
      if (method === 'viewerEnd') cleanup = true;
      return 'ciphertext';
    });
    const request = vi.fn(async (message: any) => {
      if (message.kind === stage || (stage === 'cleanup' && cleanup))
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      if (message.kind === 'status') return { version: 1, state: 'locked' };
      if (message.kind === 'prepare') return { version: 1, ready: true, descriptor: 'host' };
      if (message.kind === 'open') return { handle: 'remote', offer: 'offer' };
      return { ciphertext: 'reply' };
    }) as any;
    const credentials = new ViewerCredentials({ request });
    const old = credentials.run('old', 'darwin', 'unlock', undefined, () => {});
    const oldRejected = expect(old).rejects.toThrow(
      stage === 'cleanup' ? 'CREDENTIAL_PASSWORD_REJECTED' : 'CREDENTIAL_CANCELLED',
    );
    await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
    credentials.dispose();
    const replacement = credentials.run('replacement', 'darwin', 'settings', undefined, () => {});
    await vi.waitFor(() => expect(finishNew).toBeTypeOf('function'));
    const nativeCalls = native.call.mock.calls.length;
    finishOld({});
    await oldRejected;
    expect(native.call).toHaveBeenCalledTimes(nativeCalls);
    expect(native.dispose).toHaveBeenCalledOnce();
    await expect(
      credentials.run('third', 'darwin', 'settings', undefined, () => {}),
    ).rejects.toThrow('CREDENTIAL_AUTHENTICATION_BUSY');
    finishNew({ autoUnlock: true });
    await expect(replacement).resolves.toMatchObject({ available: true, autoUnlock: true });
    await expect(
      credentials.run('third', 'darwin', 'settings', undefined, () => {}),
    ).resolves.toMatchObject({ available: true });
  },
);
