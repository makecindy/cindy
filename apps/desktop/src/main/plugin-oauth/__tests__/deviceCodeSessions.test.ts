import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_INVOKE_ALLOWLIST } from '@cindy/device-link';
import { LocalDeviceCodeSessions } from '../deviceCodeSessions';
import { copyPrivateDeviceCode } from '../deviceCodeClipboard';
import { PLUGIN_OAUTH_DEVICE_CODE_CHANNEL } from '../../../shared/pluginOauthDeviceCode';

const target = {
  deviceId: 'device-a',
  ghostId: 'cindy-github',
  requestId: 'card-a',
  actionId: 'connect',
};
const scope = 'owner-a:window-a:frame-a';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup() {
  const registry = new LocalDeviceCodeSessions();
  let clipboard = '';
  let current = true;
  const board = {
    readText: () => clipboard,
    writeText: (code: string) => {
      clipboard = code;
    },
    clear: () => {
      clipboard = '';
    },
  };
  const clear = copyPrivateDeviceCode(board, 'TEST-CODE');
  const copy = vi.fn((code: string) => {
    copyPrivateDeviceCode(board, code);
  });
  const openExternal = vi.fn(async (_url: string) => {});
  const close = registry.present(
    scope,
    target,
    { userCode: 'TEST-CODE', authorizeUrl: 'https://github.com/login/device', expiresAt: 61_000 },
    {
      assertCurrent: () => {
        if (!current) throw new Error('stale');
      },
      copy,
      openExternal,
      clearClipboard: clear,
    },
  );
  return {
    registry,
    copy,
    openExternal,
    close,
    clear,
    clipboard: () => clipboard,
    overwrite: () => {
      clipboard = 'unrelated text';
    },
    stale: () => {
      current = false;
    },
    read: () => registry.handle(scope, { ...target, operation: 'read' }),
  };
}

it('returns only the display projection and supports repeated copy and exact reopen without restarting authorization', async () => {
  const h = setup();
  expect(await h.read()).toEqual({
    phase: 'ready',
    userCode: 'TEST-CODE',
    verificationHost: 'github.com',
    expiresAt: 61_000,
    copiedAt: 1000,
  });
  for (let i = 0; i < 2; i++) {
    h.overwrite();
    await h.registry.handle(scope, { ...target, operation: 'copy' });
    expect(h.clipboard()).toBe('TEST-CODE');
  }
  await h.registry.handle(scope, { ...target, operation: 'reopen' });
  expect(h.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/login/device');
  expect(h.copy).toHaveBeenCalledTimes(2);
  h.close('completed');
  h.clear();
  expect(await h.read()).toEqual({ phase: 'completed' });
  expect(h.clipboard()).toBe('');
});

it.each(['deviceId', 'ghostId', 'requestId', 'actionId'] as const)(
  'does not disclose another %s or accept its copy request',
  async (field) => {
    const h = setup();
    const other = { ...target, [field]: 'other' };
    expect(await h.registry.handle(scope, { ...other, operation: 'read' })).toBeNull();
    await expect(h.registry.handle(scope, { ...other, operation: 'copy' })).rejects.toThrow(
      'OAUTH_BRIDGE_UNAVAILABLE',
    );
    expect(h.copy).not.toHaveBeenCalled();
  },
);

it.each(['owner-b:window-a:frame-a', 'owner-a:window-b:frame-a', 'owner-a:window-a:frame-b'])(
  'does not disclose across scope %s',
  async (other) => {
    const h = setup();
    expect(await h.registry.handle(other, { ...target, operation: 'read' })).toBeNull();
    await expect(h.registry.handle(other, { ...target, operation: 'reopen' })).rejects.toThrow();
    expect(h.openExternal).not.toHaveBeenCalled();
  },
);

it.each([
  { userCode: 'TEST-CODE' },
  { url: 'https://evil.example/' },
  { operation: 'execute' },
  { operation: 4 },
])('rejects untrusted additions/operations %j', async (extra) => {
  const h = setup();
  await expect(
    h.registry.handle(scope, { ...target, operation: 'copy', ...extra }),
  ).rejects.toThrow();
  expect(h.copy).not.toHaveBeenCalled();
});

it('expires without a reader, removes the code and clipboard, and cannot become completed later', async () => {
  const h = setup();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await h.read()).toEqual({ phase: 'expired' });
  expect(h.clipboard()).toBe('');
  await expect(h.registry.handle(scope, { ...target, operation: 'copy' })).rejects.toThrow();
  h.close('completed');
  expect(await h.read()).toEqual({ phase: 'expired' });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await h.read()).toBeNull();
});

it('rechecks owner/peer/frame validity on read, copy, and after opening the browser', async () => {
  const h = setup();
  h.openExternal.mockImplementation(async () => {
    h.stale();
  });
  await expect(h.registry.handle(scope, { ...target, operation: 'reopen' })).rejects.toThrow();
  await expect(h.read()).rejects.toThrow();
  await expect(h.registry.handle(scope, { ...target, operation: 'copy' })).rejects.toThrow();
  expect(h.copy).not.toHaveBeenCalled();
});

it('preserves newer clipboard content on completion and disallows remote invocation', () => {
  const h = setup();
  h.overwrite();
  h.close('ended');
  h.clear();
  expect(h.clipboard()).toBe('unrelated text');
  expect(REMOTE_INVOKE_ALLOWLIST.has(PLUGIN_OAUTH_DEVICE_CODE_CHANNEL)).toBe(false);
});

it('reopens a browser authorization without exposing its URL, copying a code, or creating another transaction', async () => {
  const registry = new LocalDeviceCodeSessions();
  const url = 'https://accounts.example.com/authorize?state=private-state';
  const open = vi.fn(async (_url: string) => {});
  const close = registry.presentBrowser(
    scope,
    target,
    61_000,
    () => {},
    () => open(url),
  );
  const read = () => registry.handle(scope, { ...target, operation: 'read' });
  expect(await read()).toEqual({ phase: 'browser', expiresAt: 61_000 });
  await registry.handle(scope, { ...target, operation: 'reopen' });
  expect(open).toHaveBeenCalledExactlyOnceWith(url);
  await expect(registry.handle(scope, { ...target, operation: 'copy' })).rejects.toThrow();
  expect(await registry.handle('different-frame', { ...target, operation: 'read' })).toBeNull();
  close('ended');
  expect(await read()).toEqual({ phase: 'ended' });
  await expect(registry.handle(scope, { ...target, operation: 'reopen' })).rejects.toThrow();
});

it('expires browser-only authorizations and revalidates the initiating frame after reopen', async () => {
  const registry = new LocalDeviceCodeSessions();
  let current = true;
  const assertCurrent = () => {
    if (!current) throw new Error('stale');
  };
  registry.presentBrowser(scope, target, 61_000, assertCurrent, async () => {
    current = false;
  });
  await expect(registry.handle(scope, { ...target, operation: 'reopen' })).rejects.toThrow();
  current = true;
  expect(await registry.handle(scope, { ...target, operation: 'read' })).toEqual({
    phase: 'ended',
  });
  registry.presentBrowser(scope, target, 61_000, assertCurrent, async () => {});
  await vi.advanceTimersByTimeAsync(60_001);
  expect(await registry.handle(scope, { ...target, operation: 'read' })).toEqual({
    phase: 'expired',
  });
});
