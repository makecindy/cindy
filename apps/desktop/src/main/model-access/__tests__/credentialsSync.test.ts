/**
 * credentialsSync 单测:网关凭据自动下发状态机(依赖全注入,不起 Electron)。
 * 覆盖:成功落盘、值未变不写 key、503 disabled、403 unsupported 终态、
 * 失败重试后 failed、登出复位作废在途重试、rotate 语义、手填标记。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createCredentialsSync,
  type CredentialsPayload,
  type CredentialsSyncDeps,
} from '../credentialsSync.js';
import {
  createModelAccessCredentialsStore,
  type CredentialsStoreIo,
} from '../credentialsStore.js';
import type { ModelAccessStatus } from '../../../shared/modelAccess.js';

function memoryIo(): CredentialsStoreIo {
  let content: string | null = null;
  return {
    read: () => content,
    write: (text) => {
      content = text;
    },
    remove: () => {
      content = null;
    },
  };
}

function serverError(code: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(code), { code, statusCode });
}

interface Harness {
  sync: ReturnType<typeof createCredentialsSync>;
  statuses: ModelAccessStatus[];
  written: string[];
  fetchMock: ReturnType<typeof vi.fn>;
  rotateMock: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof createModelAccessCredentialsStore>;
  setLocalKey(key: string | null): void;
}

function makeHarness(overrides: Partial<CredentialsSyncDeps> = {}): Harness {
  const store = createModelAccessCredentialsStore(memoryIo());
  const statuses: ModelAccessStatus[] = [];
  const written: string[] = [];
  let localKey: string | null = null;
  const fetchMock = vi.fn<() => Promise<CredentialsPayload>>();
  const rotateMock = vi.fn<() => Promise<CredentialsPayload>>();
  const sync = createCredentialsSync({
    fetchCredentials: fetchMock,
    rotateCredentials: rotateMock,
    readXdKey: () => localKey,
    writeXdKey: async (key) => {
      written.push(key);
      localKey = key;
      return true;
    },
    store,
    onStatusChange: (s) => statuses.push(s),
    retryDelaysMs: [1, 1],
    sleep: () => Promise.resolve(),
    ...overrides,
  });
  return {
    sync,
    statuses,
    written,
    fetchMock,
    rotateMock,
    store,
    setLocalKey: (k) => {
      localKey = k;
    },
  };
}

describe('credentialsSync', () => {
  it('owner switch reloads endpoint metadata from the new owner namespace', () => {
    let owner = 'user-a';
    const contents = new Map<string, string>();
    const store = createModelAccessCredentialsStore(
      {
        read: () => contents.get(owner) ?? null,
        write: (text) => {
          contents.set(owner, text);
        },
        remove: () => {
          contents.delete(owner);
        },
      },
      () => owner,
    );

    store.setServerCredentials('https://tenant-a.test.invalid/');
    owner = 'user-b';
    expect(store.getServerEndpoint()).toBeNull();

    store.setServerCredentials('https://tenant-b.test.invalid/');
    owner = 'user-a';
    expect(store.getServerEndpoint()).toBe('https://tenant-a.test.invalid');
  });

  it('成功:写 key + 记录 server endpoint,状态 syncing → ok', async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue({ endpoint: 'https://laxa.test.invalid/', apiKey: 'sk-u1' });

    const result = await h.sync.sync();
    expect(result.state).toBe('ok');
    expect(result.source).toBe('server');
    expect(result.endpoint).toBe('https://laxa.test.invalid'); // 尾斜杠归一
    expect(h.written).toEqual(['sk-u1']);
    expect(h.statuses.map((s) => s.state)).toEqual(['syncing', 'ok']);
  });

  it('值未变:不写 key(不触发 codex 重启),endpoint 照常刷新', async () => {
    const h = makeHarness();
    h.setLocalKey('sk-u1');
    h.fetchMock.mockResolvedValue({ endpoint: 'https://laxa.test.invalid', apiKey: 'sk-u1' });

    const result = await h.sync.sync();
    expect(result.state).toBe('ok');
    expect(h.written).toEqual([]); // 未写
    expect(h.store.getServerEndpoint()).toBe('https://laxa.test.invalid');
  });

  it('503 → disabled 终态:不写任何东西,重复 sync 不再打服务端;retry 可重新发起', async () => {
    const h = makeHarness();
    h.fetchMock.mockRejectedValue(serverError('MODEL_ACCESS_DISABLED', 503));

    const first = await h.sync.sync();
    expect(first.state).toBe('disabled');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.written).toEqual([]);
    expect(h.store.getSource()).toBeNull();

    await h.sync.sync(); // 终态,不再请求
    expect(h.fetchMock).toHaveBeenCalledTimes(1);

    // 灰度打开后手动重试恢复
    h.fetchMock.mockResolvedValue({ endpoint: 'https://laxa.test.invalid', apiKey: 'sk-u1' });
    const retried = await h.sync.retry();
    expect(retried.state).toBe('ok');
  });

  it('403 ORG_NOT_SUPPORTED → unsupported 终态,不重试', async () => {
    const h = makeHarness();
    h.fetchMock.mockRejectedValue(serverError('ORG_NOT_SUPPORTED', 403));

    const result = await h.sync.sync();
    expect(result.state).toBe('unsupported');
    expect(h.fetchMock).toHaveBeenCalledTimes(1); // 无自动重试

    await h.sync.sync();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络/5xx 失败:退避重试用尽后 failed,本地既有 key 不受影响', async () => {
    const h = makeHarness();
    h.setLocalKey('sk-old');
    h.fetchMock.mockRejectedValue(serverError('GATEWAY_ERROR', 502));

    const result = await h.sync.sync();
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SYNC_FAILED');
    expect(h.fetchMock).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
    expect(h.written).toEqual([]); // 绝不清/写本地 key
  });

  it('写 key 失败(safeStorage 不可用)→ failed(SAFE_STORAGE_UNAVAILABLE)', async () => {
    const h = makeHarness({ writeXdKey: async () => false });
    h.fetchMock.mockResolvedValue({ endpoint: 'https://laxa.test.invalid', apiKey: 'sk-u1' });

    const result = await h.sync.sync();
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('SAFE_STORAGE_UNAVAILABLE');
    expect(h.store.getSource()).toBeNull(); // endpoint 不落(与 key 同源不变量)
  });

  it('并发 sync single-flight:请求只发一次', async () => {
    const h = makeHarness();
    let resolveFetch!: (v: CredentialsPayload) => void;
    h.fetchMock.mockReturnValue(
      new Promise<CredentialsPayload>((r) => {
        resolveFetch = r;
      }),
    );

    const p1 = h.sync.sync();
    const p2 = h.sync.sync();
    resolveFetch({ endpoint: 'https://laxa.test.invalid', apiKey: 'sk-u1' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.state).toBe('ok');
    expect(r2.state).toBe('ok');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('登出作废在途重试:handleAuthChange(false) 后不再继续尝试', async () => {
    const h = makeHarness();
    let failCount = 0;
    h.fetchMock.mockImplementation(() => {
      failCount++;
      if (failCount === 1) {
        // 首次失败后、退避期间触发登出
        h.sync.handleAuthChange({ isAuthenticated: false });
      }
      return Promise.reject(serverError('GATEWAY_ERROR', 502));
    });

    const result = await h.sync.sync();
    expect(result.state).toBe('idle'); // 登出复位,放弃本轮
    expect(h.fetchMock).toHaveBeenCalledTimes(1); // 无第二次尝试
  });

  it('rotate:调 rotate 接口并覆盖本地;等待在途 sync 完成后执行', async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue({ endpoint: 'https://laxa.test.invalid', apiKey: 'sk-u1' });
    await h.sync.sync();

    h.rotateMock.mockResolvedValue({ endpoint: 'https://laxa.test.invalid', apiKey: 'sk-u2' });
    const rotated = await h.sync.rotate();
    expect(rotated.state).toBe('ok');
    expect(h.written).toEqual(['sk-u1', 'sk-u2']);
  });

  it('rotate 失败:错误原样上抛,状态不误翻 ok', async () => {
    const h = makeHarness();
    h.rotateMock.mockRejectedValue(serverError('GATEWAY_ERROR', 502));
    await expect(h.sync.rotate()).rejects.toMatchObject({ code: 'GATEWAY_ERROR' });
  });

  it('手填标记:noteManualKeySaved → source=manual;noteManualKeyRemoved → 清标记', () => {
    const h = makeHarness();
    h.sync.noteManualKeySaved();
    expect(h.store.getSource()).toBe('manual');
    expect(h.store.getServerEndpoint()).toBeNull();

    h.sync.noteManualKeyRemoved();
    expect(h.store.getSource()).toBeNull();
  });

  it('异常 2xx 响应(空 key / 坏 endpoint)不覆盖本地凭据,按可重试失败处理', async () => {
    const h = makeHarness();
    h.setLocalKey('sk-old');
    h.fetchMock.mockResolvedValue({ endpoint: 'not-a-url', apiKey: '' });

    const result = await h.sync.sync();
    expect(result.state).toBe('failed');
    expect(h.written).toEqual([]); // 本地 key 原样保留
    expect(h.store.getSource()).toBeNull(); // endpoint 不落盘
  });

  it('换号(A→B,不经过登出)作废 A 的在途响应:不写盘,并为 B 发起新请求', async () => {
    const h = makeHarness();
    const resolvers: Array<(v: CredentialsPayload) => void> = [];
    h.fetchMock.mockImplementation(
      () => new Promise<CredentialsPayload>((r) => resolvers.push(r)),
    );

    h.sync.handleAuthChange({ isAuthenticated: true, userId: 'user-a' });
    await Promise.resolve();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);

    // A 的请求在途时切到 B —— 必须作废旧请求并新发一轮
    h.sync.handleAuthChange({ isAuthenticated: true, userId: 'user-b' });
    await Promise.resolve();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);

    // A 的响应迟到:绝不写盘
    resolvers[0]({ endpoint: 'https://tenant-a.test.invalid', apiKey: 'sk-a' });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.written).toEqual([]);

    // B 的响应正常落盘
    resolvers[1]({ endpoint: 'https://tenant-b.test.invalid', apiKey: 'sk-b' });
    await vi.waitFor(() => {
      expect(h.sync.getStatus().state).toBe('ok');
    });
    expect(h.written).toEqual(['sk-b']);
    expect(h.store.getServerEndpoint()).toBe('https://tenant-b.test.invalid');
  });

  it('同账号跨区作废旧 realm 的在途响应,并从新 realm 重新同步', async () => {
    const h = makeHarness();
    const resolvers: Array<(v: CredentialsPayload) => void> = [];
    h.fetchMock.mockImplementation(
      () => new Promise<CredentialsPayload>((resolve) => resolvers.push(resolve)),
    );

    h.sync.handleAuthChange({ isAuthenticated: true, userId: 'user-a', realm: 'cn' });
    await Promise.resolve();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);

    h.sync.handleAuthChange({ isAuthenticated: true, userId: 'user-a', realm: 'global' });
    await Promise.resolve();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);

    resolvers[0]({ endpoint: 'https://cn.test.invalid', apiKey: 'sk-cn' });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.written).toEqual([]);

    resolvers[1]({ endpoint: 'https://global.test.invalid', apiKey: 'sk-global' });
    await vi.waitFor(() => {
      expect(h.sync.getStatus().state).toBe('ok');
    });
    expect(h.written).toEqual(['sk-global']);
    expect(h.store.getServerEndpoint()).toBe('https://global.test.invalid');
  });

  it('登录触发 handleAuthChange(true) 自动同步', async () => {
    const h = makeHarness();
    h.fetchMock.mockResolvedValue({ endpoint: 'https://laxa.test.invalid', apiKey: 'sk-u1' });

    h.sync.handleAuthChange({ isAuthenticated: true });
    await vi.waitFor(() => {
      expect(h.sync.getStatus().state).toBe('ok');
    });
  });
});
