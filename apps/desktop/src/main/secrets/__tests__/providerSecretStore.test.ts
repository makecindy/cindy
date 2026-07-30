import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionState = vi.hoisted(() => ({
  mode: 'signed-out' as 'signed-out' | 'local' | 'cloud',
  dataOwnerId: null as string | null,
}));

// providerSecretStore 顶层 `import { app, safeStorage } from 'electron'` —— 这些测试
// 注入自己的 SecretStorageIo,不会走默认 electronSecretIo,因此 electron mock 只为
// 让 import 链在 node 测试环境下可加载(app.getPath 给个 tmp 目录即可)。
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/xdt-provider-secret-test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ ...sessionState, generation: 0 }),
  dataOwnerStorageKey: (ownerId: string) => ownerId,
  LOCAL_DATA_OWNER_ID: 'local-v1',
}));

import {
  createProviderSecretStore,
  readCustomProviderKeyForMutation,
  readGhostSecretTailFromIo,
  setProviderSecretsClearedListener,
  type SecretStorageIo,
} from '../providerSecretStore';
import {
  providerSecretStorageKey,
  customMcpSecretStorageKey,
  customProviderSecretStorageKey,
  providerOAuthStorageKey,
  ghostSecretStorageKey,
  ghostSecretHintStorageKey,
  deriveGhostSecretTail,
  GHOST_SECRET_TAIL_MIN_VALUE_CHARS,
  isRendererAccessibleSafeStorageKey,
  PROVIDER_SECRET_IDS,
} from '../../../shared/providerSecrets';

/** 内存版 SecretStorageIo:按"存储键名"读写一个 Map,模拟 safeStorage 文件层。 */
function createMemoryIo(): SecretStorageIo & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    isAvailable: () => true,
    read: (k) => (store.has(k) ? (store.get(k) as string) : null),
    write: (k, v) => {
      store.set(k, v);
      return true;
    },
    remove: (k) => {
      store.delete(k);
      return { success: true };
    },
    list: () => [...store.keys()],
  };
}

describe('providerSecrets registry', () => {
  it('maps known providers to their stable storage keys', () => {
    expect(providerSecretStorageKey('xd')).toBe('api_key');
    expect(providerSecretStorageKey('mivo')).toBe('mivo_api_key');
    expect(providerSecretStorageKey('brave')).toBe('brave_search_api_key');
    expect(providerSecretStorageKey('tavily')).toBe('tavily_api_key');
    expect(providerSecretStorageKey('voice-asr')).toBe('voice_input_asr_api_key');
  });

  it('lists all registered provider ids', () => {
    expect(PROVIDER_SECRET_IDS).toEqual(
      expect.arrayContaining(['xd', 'mivo', 'brave', 'tavily', 'voice-asr']),
    );
  });

  it('keeps the voice ASR key behind its dedicated main-only IPC boundary', () => {
    expect(isRendererAccessibleSafeStorageKey(providerSecretStorageKey('voice-asr'))).toBe(false);
    expect(isRendererAccessibleSafeStorageKey('VOICE_INPUT_ASR_API_KEY')).toBe(false);
    expect(isRendererAccessibleSafeStorageKey(providerSecretStorageKey('xd'))).toBe(true);
    expect(isRendererAccessibleSafeStorageKey(customMcpSecretStorageKey('example'))).toBe(true);
  });

  it('keeps the Gemini API key behind its dedicated main-only IPC boundary', () => {
    expect(isRendererAccessibleSafeStorageKey(providerSecretStorageKey('gemini'))).toBe(false);
    expect(isRendererAccessibleSafeStorageKey('PROVIDER_KEY_GEMINI')).toBe(false);
  });

  it('keeps the OpenAI images API key behind its dedicated main-only IPC boundary', () => {
    expect(isRendererAccessibleSafeStorageKey(providerSecretStorageKey('openai-images'))).toBe(false);
    expect(isRendererAccessibleSafeStorageKey('PROVIDER_KEY_OPENAI_IMAGES')).toBe(false);
  });

  it('动态键名构造前校验片段字符集,路径逃逸类 id 直接抛错', () => {
    expect(providerOAuthStorageKey('acme-1')).toBe('provider_oauth_acme-1');
    expect(customProviderSecretStorageKey('my_or', 'claude-code')).toBe('provider_key_my_or_claude-code');
    expect(() => providerOAuthStorageKey('x/../../oauth')).toThrow(/illegal characters/);
    expect(() => providerOAuthStorageKey('a.b')).toThrow(/illegal characters/);
    expect(() => customProviderSecretStorageKey('ok', 'claude/../code')).toThrow(/illegal characters/);
  });

  it('意识凭证键名构造(ghost_secret_<ghostId>_<key>),非法片段抛错', () => {
    expect(ghostSecretStorageKey('my-ghost', 'brave_api_key')).toBe('ghost_secret_my-ghost_brave_api_key');
    expect(() => ghostSecretStorageKey('x/../evil', 'k')).toThrow(/illegal characters/);
    expect(() => ghostSecretStorageKey('ok', 'k.ey')).toThrow(/illegal characters/);
  });

  it('官方别名:cindy-web-search 的凭证映射到历史 brave/tavily 存储键(老用户零迁移)', () => {
    // 与「工具密钥」时代同一 .enc 文件:老用户已填 key 对意识立即生效,
    // lizi_web_search MCP 也照读同一份。
    expect(ghostSecretStorageKey('cindy-web-search', 'brave_api_key')).toBe(providerSecretStorageKey('brave'));
    expect(ghostSecretStorageKey('cindy-web-search', 'tavily_api_key')).toBe(providerSecretStorageKey('tavily'));
    // 别名只对登记过的 (ghostId, key) 生效:同 id 其它 key、其它意识同名 key 都走缺省命名空间。
    expect(ghostSecretStorageKey('cindy-web-search', 'other_key')).toBe('ghost_secret_cindy-web-search_other_key');
    expect(ghostSecretStorageKey('third-party', 'brave_api_key')).toBe('ghost_secret_third-party_brave_api_key');
  });

  it('官方别名:xd-mivo 的 mivo_api_key 映射到历史 mivo 存储键(老用户零迁移)', () => {
    expect(ghostSecretStorageKey('xd-mivo', 'mivo_api_key')).toBe(providerSecretStorageKey('mivo'));
    expect(ghostSecretStorageKey('xd-mivo', 'other_key')).toBe('ghost_secret_xd-mivo_other_key');
    expect(ghostSecretStorageKey('third-party', 'mivo_api_key')).toBe('ghost_secret_third-party_mivo_api_key');
  });

  it('意识凭证尾指纹:键名独立前缀(ghost_hint_)+ 短值不产指纹', () => {
    expect(ghostSecretHintStorageKey('my-ghost', 'api_key')).toBe('ghost_hint_my-ghost_api_key');
    expect(() => ghostSecretHintStorageKey('x/../evil', 'k')).toThrow(/illegal characters/);
    // 指纹永远走 ghost_hint_ 命名空间,官方别名(密文键)不牵连它。
    expect(ghostSecretHintStorageKey('xd-mivo', 'mivo_api_key')).toBe('ghost_hint_xd-mivo_mivo_api_key');

    expect(deriveGhostSecretTail('mivo_abcdefgh1234')).toBe('1234');
    expect(deriveGhostSecretTail('x'.repeat(GHOST_SECRET_TAIL_MIN_VALUE_CHARS))).toBe('xxxx');
    expect(deriveGhostSecretTail('x'.repeat(GHOST_SECRET_TAIL_MIN_VALUE_CHARS - 1))).toBeNull();
    expect(deriveGhostSecretTail('')).toBeNull();
  });

  it('every registered storage key is a valid safe-storage key name', () => {
    // 与 bootstrap-electron 的 isValidKey 同正则;新增供应商若键名非法这里会红。
    const valid = /^[a-zA-Z0-9_-]+$/;
    for (const id of PROVIDER_SECRET_IDS) {
      expect(providerSecretStorageKey(id)).toMatch(valid);
    }
  });

  it('strict custom-provider snapshot treats a missing file as absent when encryption is unavailable', () => {
    const previousMode = sessionState.mode;
    const previousOwnerId = sessionState.dataOwnerId;
    sessionState.mode = 'cloud';
    sessionState.dataOwnerId = `missing-key-owner-${process.pid}`;
    try {
      expect(
        readCustomProviderKeyForMutation(`missing-key-provider-${process.pid}`, 'codex'),
      ).toBeNull();
    } finally {
      sessionState.mode = previousMode;
      sessionState.dataOwnerId = previousOwnerId;
    }
  });
});

describe('providerSecretStore', () => {
  let io: ReturnType<typeof createMemoryIo>;

  beforeEach(() => {
    io = createMemoryIo();
    setProviderSecretsClearedListener(() => {});
  });

  it('set then get round-trips by provider id, keyed by storage name', () => {
    const store = createProviderSecretStore(io);
    expect(store.set('xd', 'sk-test')).toBe(true);
    expect(store.get('xd')).toBe('sk-test');
    // 落盘用的是 registry 解析出的"存储键名",而非 provider id 本身。
    expect(io.store.get('api_key')).toBe('sk-test');
    expect(io.store.has('xd')).toBe(false);
  });

  it('get returns null for an unconfigured provider', () => {
    const store = createProviderSecretStore(io);
    expect(store.get('mivo')).toBeNull();
    expect(store.has('mivo')).toBe(false);
  });

  it('has reflects presence after set', () => {
    const store = createProviderSecretStore(io);
    store.set('mivo', 'mivo_abc');
    expect(store.has('mivo')).toBe(true);
  });

  it('remove deletes the secret and is idempotent', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-x');
    expect(store.remove('xd')).toEqual({ success: true });
    expect(store.get('xd')).toBeNull();
    // 再删一次(已不存在)仍成功(幂等)。
    expect(store.remove('xd')).toEqual({ success: true });
  });

  it('isolates providers by storage key', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-xd');
    store.set('mivo', 'mivo_m');
    store.remove('xd');
    expect(store.get('xd')).toBeNull();
    expect(store.get('mivo')).toBe('mivo_m');
  });

  it('get/has swallow io.read errors and return null/false', () => {
    const throwingIo: SecretStorageIo = {
      isAvailable: () => true,
      read: () => {
        throw new Error('boom');
      },
      write: () => false,
      remove: () => ({ success: true }),
      list: () => [],
    };
    const store = createProviderSecretStore(throwingIo);
    expect(store.get('xd')).toBeNull();
    expect(store.has('xd')).toBe(false);
  });
});

describe('readGhostSecretTailFromIo(尾指纹读取 + 老键懒回填)', () => {
  let io: ReturnType<typeof createMemoryIo>;

  beforeEach(() => {
    io = createMemoryIo();
    setProviderSecretsClearedListener(() => {});
  });

  it('已有预截指纹时直接回,不碰密文', () => {
    io.store.set(ghostSecretHintStorageKey('my-ghost', 'api_key'), '1234');
    expect(readGhostSecretTailFromIo(io, 'my-ghost', 'api_key')).toBe('1234');
  });

  it('老键无指纹但密文存在 → 懒回填:补截落库并返回', () => {
    io.store.set(ghostSecretStorageKey('my-ghost', 'api_key'), 'mivo_abcdefgh5678');
    expect(readGhostSecretTailFromIo(io, 'my-ghost', 'api_key')).toBe('5678');
    // 回填已落库,下次直接命中预截值。
    expect(io.store.get(ghostSecretHintStorageKey('my-ghost', 'api_key'))).toBe('5678');
  });

  it('官方别名键(xd-mivo 老用户)同样能懒回填', () => {
    io.store.set(ghostSecretStorageKey('xd-mivo', 'mivo_api_key'), 'mivo_legacy_key_9999');
    expect(readGhostSecretTailFromIo(io, 'xd-mivo', 'mivo_api_key')).toBe('9999');
    expect(io.store.get(ghostSecretHintStorageKey('xd-mivo', 'mivo_api_key'))).toBe('9999');
  });

  it('没存过 / 值太短不产指纹 → null 且不落回填键', () => {
    expect(readGhostSecretTailFromIo(io, 'my-ghost', 'api_key')).toBeNull();
    io.store.set(ghostSecretStorageKey('my-ghost', 'api_key'), 'short');
    expect(readGhostSecretTailFromIo(io, 'my-ghost', 'api_key')).toBeNull();
    expect(io.store.has(ghostSecretHintStorageKey('my-ghost', 'api_key'))).toBe(false);
  });

  it('io 抛错 → 吞掉回 null(端点侧降级成只显示已保存)', () => {
    const throwing: SecretStorageIo = {
      isAvailable: () => true,
      read: () => {
        throw new Error('boom');
      },
      write: () => false,
      remove: () => ({ success: true }),
      list: () => [],
    };
    expect(readGhostSecretTailFromIo(throwing, 'my-ghost', 'api_key')).toBeNull();
  });
});

describe('providerSecretStore account boundary (clearAll + reconcileOwner)', () => {
  let io: ReturnType<typeof createMemoryIo>;

  beforeEach(() => {
    io = createMemoryIo();
    setProviderSecretsClearedListener(() => {});
  });

  it('clearAll removes every registered provider secret', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-x');
    store.set('mivo', 'mivo_m');
    store.clearAll();
    expect(store.get('xd')).toBeNull();
    expect(store.get('mivo')).toBeNull();
  });

  it('换账号清理连带动态键名密钥：provider_oauth_* blob 与 provider_key_* 自定义 key', () => {
    const store = createProviderSecretStore(io);
    store.reconcileOwner('user-A');
    io.store.set('provider_oauth_acme', '{"access_token":"at-A"}');
    io.store.set('provider_key_myor_claude-code', 'sk-custom-A');
    io.store.set('unrelated_key', 'keep-me');
    const res = store.reconcileOwner('user-B');
    expect(res).toEqual({ cleared: true });
    expect(io.store.has('provider_oauth_acme')).toBe(false);
    expect(io.store.has('provider_key_myor_claude-code')).toBe(false);
    expect(io.store.get('unrelated_key')).toBe('keep-me'); // 前缀外的键不受影响
  });

  it('clearAll also sweeps dynamic custom MCP bearer tokens (mcp_token_*)', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-x');
    // 自定义 MCP token 键是动态的,不走 provider 枚举,直接写进底层 IO 模拟 safeStorage 落盘。
    io.store.set(customMcpSecretStorageKey('dida365'), 'mcp-secret-1');
    io.store.set(customMcpSecretStorageKey('slack'), 'mcp-secret-2');
    store.clearAll();
    expect(store.get('xd')).toBeNull();
    expect(io.store.has(customMcpSecretStorageKey('dida365'))).toBe(false);
    expect(io.store.has(customMcpSecretStorageKey('slack'))).toBe(false);
  });

  it('clearAll 连带清扫意识 network 槽凭证(ghost_secret_*)与尾指纹(ghost_hint_*)', () => {
    const store = createProviderSecretStore(io);
    io.store.set(ghostSecretStorageKey('web-search', 'brave_api_key'), 'BSA-xxx');
    io.store.set(ghostSecretStorageKey('web-search', 'tavily_api_key'), 'tvly-xxx');
    io.store.set(ghostSecretHintStorageKey('my-ghost', 'api_key'), '1234');
    io.store.set('unrelated_key', 'keep-me');
    store.clearAll();
    expect(io.store.has(ghostSecretStorageKey('web-search', 'brave_api_key'))).toBe(false);
    expect(io.store.has(ghostSecretStorageKey('web-search', 'tavily_api_key'))).toBe(false);
    expect(io.store.has(ghostSecretHintStorageKey('my-ghost', 'api_key'))).toBe(false);
    expect(io.store.get('unrelated_key')).toBe('keep-me');
  });

  it('reconcileOwner for a different user clears custom MCP tokens (no cross-account bleed)', () => {
    const store = createProviderSecretStore(io);
    store.reconcileOwner('user-A');
    io.store.set(customMcpSecretStorageKey('dida365'), 'A-token');
    const res = store.reconcileOwner('user-B');
    expect(res).toEqual({ cleared: true });
    expect(io.store.has(customMcpSecretStorageKey('dida365'))).toBe(false);
  });

  it('reconcileOwner on first login (no prior owner) keeps keys and records owner', () => {
    const store = createProviderSecretStore(io);
    store.set('xd', 'sk-x'); // 模拟升级前本机已有 key
    const res = store.reconcileOwner('user-A');
    expect(res).toEqual({ cleared: false });
    expect(store.get('xd')).toBe('sk-x'); // 升级后首次登录不丢 key
    expect(store.getOwnerUserId()).toBe('user-A');
  });

  it('reconcileOwner for the same user keeps keys (logout / expiry re-login)', () => {
    const store = createProviderSecretStore(io);
    store.reconcileOwner('user-A');
    store.set('xd', 'sk-x');
    store.set('mivo', 'mivo_m');
    const res = store.reconcileOwner('user-A');
    expect(res).toEqual({ cleared: false });
    expect(store.get('xd')).toBe('sk-x');
    expect(store.get('mivo')).toBe('mivo_m');
  });

  it('reconcileOwner for a different user clears keys and updates owner (no cross-account bleed)', () => {
    const store = createProviderSecretStore(io);
    store.reconcileOwner('user-A');
    store.set('xd', 'sk-A');
    store.set('mivo', 'mivo_A');
    const res = store.reconcileOwner('user-B');
    expect(res).toEqual({ cleared: true });
    expect(store.get('xd')).toBeNull();
    expect(store.get('mivo')).toBeNull();
    expect(store.getOwnerUserId()).toBe('user-B');
  });

  it('owner-scoped reconcile invalidates memory caches once per committed owner without clearing files', () => {
    sessionState.mode = 'cloud';
    sessionState.dataOwnerId = 'user-A';
    const listener = vi.fn();
    setProviderSecretsClearedListener(listener);
    const ownerScopedIo = { ...io, ownerScoped: true };
    const store = createProviderSecretStore(ownerScopedIo);

    expect(store.reconcileOwner('user-A')).toEqual({ cleared: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.reconcileOwner('user-A')).toEqual({ cleared: false });
    expect(listener).toHaveBeenCalledTimes(1);

    sessionState.dataOwnerId = 'user-B';
    io.store.set('owner_user-A_provider_oauth_acme', 'token-A');
    io.store.set('owner_user-B_provider_oauth_acme', 'token-B');
    expect(store.reconcileOwner('user-B')).toEqual({ cleared: false });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(io.store.get('owner_user-A_provider_oauth_acme')).toBe('token-A');
    expect(io.store.get('owner_user-B_provider_oauth_acme')).toBe('token-B');
  });
});
