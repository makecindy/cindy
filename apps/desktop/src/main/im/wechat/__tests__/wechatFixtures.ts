import { vi } from 'vitest';
import type { IMHost } from '@cindy/im';
import type { WechatTransport } from '@cindy/wechat-ilink';
import type { DbClient } from '../../../localDb/client/DbClient';
import type { WechatIMDeps } from '../WechatIM';

export function deps(overrides: Partial<WechatIMDeps> & { host?: IMHost } = {}): WechatIMDeps {
  return {
    host: overrides.host ?? host(),
    getDbClient: overrides.getDbClient ?? (() => fakeDb()),
    createTransport:
      overrides.createTransport ??
      (() => {
        throw new Error('transport should not be created');
      }),
    openAuthorizationUrl: overrides.openAuthorizationUrl ?? vi.fn(),
    captureAccountGeneration: overrides.captureAccountGeneration ?? (() => 1),
    isAccountGenerationCurrent:
      overrides.isAccountGenerationCurrent ?? ((generation) => generation === 1),
    isCompatibilityDisabled: overrides.isCompatibilityDisabled ?? (() => false),
    now: overrides.now ?? (() => 100),
  };
}

export function host(
  options: {
    secretAvailable?: boolean;
    secretRead?: (name: string) => string | null;
  } = {},
): IMHost {
  return {
    secrets: {
      isAvailable: () => options.secretAvailable ?? true,
      read: vi.fn(options.secretRead ?? (() => null)),
      write: vi.fn(() => true),
      remove: vi.fn(),
    },
    ipc: {
      throwIpcError: (code, message) => {
        throw new Error(`[${code}] ${message}`);
      },
      handle: vi.fn(),
      broadcast: vi.fn(),
    },
    paths: {
      feishuMediaDir: 'unused',
    },
    httpPostForm: vi.fn(),
  };
}

export function fakeDb(overrides: Partial<DbClient> = {}): DbClient {
  return {
    tx: overrides.tx ?? vi.fn(),
    query: overrides.query ?? vi.fn(),
    queryOne: overrides.queryOne ?? vi.fn(),
    exec: overrides.exec ?? vi.fn(),
    drizzle: {} as DbClient['drizzle'],
    vecAvailable: false,
    dispose: overrides.dispose ?? vi.fn(),
  };
}


export function blockingLiveTransport(): WechatTransport {
  return {
    notifyStart: vi.fn(async () => undefined),
    notifyStop: vi.fn(async () => undefined),
    poll: vi.fn(
      (_cursor: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    ),
  } as unknown as WechatTransport;
}
