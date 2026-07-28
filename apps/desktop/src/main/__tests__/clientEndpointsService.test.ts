/**
 * clientEndpointsService 单测(规则 14:依赖注入 + 内存 harness)。
 *
 * 校验语义(缺省字段归一/协议白名单/allowHttp)在 @cindy/maker-shared 侧已覆盖;
 * 这里只测 desktop 宿主层:清单来源解析(resolveEndpointSource 表驱动)、
 * 阻断式重试循环(失败 → prompt → 重试/退出,无静默降级、无烘焙合并)、
 * 弹框前的网络层自动重试(mac 首装瞬时失败自愈;配置事故不消耗预算)、
 * 失败 reason 带错误码、
 * file 模式的 allowHttp 放行、init 前 getter 抛错(启动时序守卫)、sendSync IPC 形状。
 */
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEST_CLIENT_ENDPOINTS } from '../../test/vitest/clientEndpointsFixture';

const ipcOn = vi.hoisted(() => vi.fn());
const netRequest = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(),
    getAppPath: vi.fn(() => '/repo/apps/desktop'),
    isPackaged: false,
    exit: vi.fn(),
  },
  dialog: { showMessageBoxSync: vi.fn() },
  ipcMain: { on: ipcOn },
  net: { request: netRequest },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  activateClientEndpointRealm,
  getClientEndpoint,
  getClientEndpointForRealm,
  getResolvedClientEndpoints,
  loadClientEndpointsForRealm,
  registerClientEndpointsIpc,
  resetClientEndpointRealm,
  resetClientEndpointsForTest,
  resolveClientEndpointsBlocking,
  resolveEndpointSource,
  CLIENT_ENDPOINTS_SYNC_CHANNEL,
  type BlockingResolveDeps,
} from '../clientEndpointsService';

afterEach(() => {
  resetClientEndpointsForTest();
  ipcOn.mockClear();
  netRequest.mockReset();
});

const FULL_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  apiBaseUrl: 'https://api.remote.example.com',
  authApiBaseUrl: 'https://auth.remote.example.com',
  deviceLinkApiBaseUrl: 'https://device.remote.example.com',
  oauthBrokerApiBaseUrl: 'https://oauth.remote.example.com',
  ossApiBaseUrl: 'https://oss.remote.example.com',
  heartbeatUrl: 'https://heartbeat.remote.example.com',
  telegramHookWsUrl: 'wss://telegram-hook.remote.example.com',
  slackHookWsUrl: 'wss://hook.remote.example.com',
  websiteUrl: 'https://www.remote.example.com',
  modelAccessApiBaseUrl: 'https://model-access.remote.example.com',
  voiceApiBaseUrl: 'https://voice.remote.example.com',
  githubApiBaseUrl: 'https://github-api.remote.example.com',
  skillhubApiBaseUrl: 'https://skillhub.remote.example.com',
  pluginApiBaseUrl: 'https://plugin.remote.example.com',
  cdnBaseUrl: 'https://cdn.remote.example.com/app',
  mobileUpdateBaseUrl: 'https://mobile-update.remote.example.com',
});

/** localhost http 清单(local 模式 endpoint.local.json 形态)。 */
const LOCAL_MANIFEST = JSON.stringify({
  ...(JSON.parse(FULL_MANIFEST) as Record<string, unknown>),
  apiBaseUrl: 'http://localhost:3333',
  authApiBaseUrl: 'http://localhost:3344',
  deviceLinkApiBaseUrl: 'http://localhost:3335',
});

describe('resolveEndpointSource(清单来源三选一)', () => {
  const REPO_ROOT = path.join('/repo');
  const DEFAULT_FILE = path.join(REPO_ROOT, 'config', 'endpoint.json');

  it.each([
    ['packaged 恒 CDN', { isPackaged: true, env: {} }, { kind: 'cdn' }],
    [
      'packaged 下 dev 覆写全部忽略',
      {
        isPackaged: true,
        env: { XDT_ENDPOINTS_CDN: '1', XDT_ENDPOINT_MANIFEST_FILE: '/x/y.json' },
      },
      { kind: 'cdn' },
    ],
    [
      'dev 默认读仓内 cn 正本',
      { isPackaged: false, env: {} },
      { kind: 'file', filePath: DEFAULT_FILE },
    ],
    [
      'dev + XDT_ENDPOINTS_CDN=1 走 CDN',
      { isPackaged: false, env: { XDT_ENDPOINTS_CDN: '1' } },
      { kind: 'cdn' },
    ],
    [
      'dev + 开关非 1 不生效',
      { isPackaged: false, env: { XDT_ENDPOINTS_CDN: 'true' } },
      { kind: 'file', filePath: DEFAULT_FILE },
    ],
    [
      'dev + 文件覆写(绝对路径原样)',
      { isPackaged: false, env: { XDT_ENDPOINT_MANIFEST_FILE: path.join('/tmp', 'e.json') } },
      { kind: 'file', filePath: path.resolve(REPO_ROOT, path.join('/tmp', 'e.json')) },
    ],
    [
      'dev + 文件覆写(相对路径以仓根为基准)',
      { isPackaged: false, env: { XDT_ENDPOINT_MANIFEST_FILE: 'config/endpoint.local.json' } },
      // path.resolve 在 Windows 上会给 '/repo' 补当前盘符,期望值同样经 resolve 归一。
      { kind: 'file', filePath: path.resolve(REPO_ROOT, 'config', 'endpoint.local.json') },
    ],
    [
      'dev + CDN 开关优先于文件覆写',
      {
        isPackaged: false,
        env: { XDT_ENDPOINTS_CDN: '1', XDT_ENDPOINT_MANIFEST_FILE: 'config/endpoint.local.json' },
      },
      { kind: 'cdn' },
    ],
  ] as const)('%s', (_label, input, expected) => {
    expect(resolveEndpointSource({ ...input, repoRoot: REPO_ROOT })).toEqual(expected);
  });
});

/** 自动重试预算关掉的公共 deps 片段(测"一轮一次尝试"的原语义)。 */
const NO_AUTO_RETRY = { autoRetryDelaysMs: [] as readonly number[] };

const okFetch = (text: string) => async () => ({ ok: true as const, text });
const failFetch = (detail: string) => async () => ({ ok: false as const, detail });

function mockNetManifest(text: string): void {
  const request = new EventEmitter() as EventEmitter & {
    abort: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  request.abort = vi.fn();
  request.end = vi.fn(() => {
    const response = new EventEmitter() as EventEmitter & { statusCode: number };
    response.statusCode = 200;
    request.emit('response', response);
    response.emit('data', Buffer.from(text));
    response.emit('end');
  });
  netRequest.mockReturnValueOnce(request);
}

describe('resolveClientEndpointsBlocking(阻断循环,清单即唯一事实源)', () => {
  it('首次成功:不进 prompt,所有值来自清单', async () => {
    const promptRetry = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(FULL_MANIFEST),
      promptRetry,
      exitApp: vi.fn(),
    });
    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
    expect(result?.cdnBaseUrl).toBe('https://cdn.remote.example.com/app');
    expect(promptRetry).not.toHaveBeenCalled();
  });

  it('清单自报区域与构建区域不一致时阻断，老清单缺 region 仍兼容', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const mismatch = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(
        JSON.stringify({
          ...(JSON.parse(FULL_MANIFEST) as object),
          region: 'global',
        }),
      ),
      promptRetry,
      exitApp: vi.fn(),
      expectedRegionWhenPresent: 'cn',
      ...NO_AUTO_RETRY,
    });
    expect(mismatch).toBeNull();
    expect(promptRetry).toHaveBeenCalledWith('region-mismatch:cn:global');

    await expect(
      resolveClientEndpointsBlocking({
        fetchManifest: okFetch(FULL_MANIFEST),
        promptRetry: vi.fn(),
        exitApp: vi.fn(),
        expectedRegionWhenPresent: 'cn',
      }),
    ).resolves.toMatchObject({
      authApiBaseUrl: 'https://auth.remote.example.com',
    });
  });

  it('失败 → prompt 选重试 → 第二次成功(无静默降级)', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_CONNECTION_REFUSED' })
      .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST });
    const promptRetry = vi.fn().mockReturnValue('retry');
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp,
      ...NO_AUTO_RETRY,
    });
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(promptRetry).toHaveBeenCalledWith('fetch-failed:ERR_CONNECTION_REFUSED');
    expect(fetchManifest).toHaveBeenCalledTimes(2);
    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
    expect(exitApp).not.toHaveBeenCalled();
  });

  it.each([
    ['字段缺失', undefined],
    ['字段空串', ''],
  ])('%s不阻断启动,解析结果归一为空串', async (_label, heartbeatUrl) => {
    const manifest = JSON.parse(FULL_MANIFEST) as Record<string, unknown>;
    if (heartbeatUrl === undefined) delete manifest.heartbeatUrl;
    else manifest.heartbeatUrl = heartbeatUrl;
    const promptRetry = vi.fn();
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(JSON.stringify(manifest)),
      promptRetry,
      exitApp,
    });
    expect(result?.heartbeatUrl).toBe('');
    expect(promptRetry).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('fetch 抛错视同失败进 prompt(reason 抽出 ERR_ 码),选退出返回 null', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: async () => {
        throw new Error('net::ERR_NAME_NOT_RESOLVED');
      },
      promptRetry,
      exitApp,
      ...NO_AUTO_RETRY,
    });
    expect(result).toBeNull();
    expect(promptRetry).toHaveBeenCalledWith('fetch-failed:ERR_NAME_NOT_RESOLVED');
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('detail 为空时 reason 退回裸 fetch-failed', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('   '),
      promptRetry,
      exitApp: vi.fn(),
      ...NO_AUTO_RETRY,
    });
    expect(promptRetry).toHaveBeenCalledWith('fetch-failed');
  });

  it('localhost http 清单:默认拒绝(CDN 路径零放松),allowHttp(file 模式)放行', async () => {
    const rejected = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(LOCAL_MANIFEST),
      promptRetry: vi.fn().mockReturnValue('exit'),
      exitApp: vi.fn(),
    });
    expect(rejected).toBeNull();

    const accepted = await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(LOCAL_MANIFEST),
      promptRetry: vi.fn(),
      exitApp: vi.fn(),
      allowHttp: true,
    });
    expect(accepted?.authApiBaseUrl).toBe('http://localhost:3344');
  });

  it('文件缺失(读取失败带 errno)进同一条阻断链路', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ENOENT'), // file 模式读不到文件
      promptRetry,
      exitApp: vi.fn(),
      allowHttp: true,
      ...NO_AUTO_RETRY,
    });
    expect(result).toBeNull();
    expect(promptRetry).toHaveBeenCalledWith('fetch-failed:ENOENT');
  });
});

describe('弹框前的自动重试(mac 首装瞬时失败自愈)', () => {
  it('网络失败后自动重试成功:用户完全看不到阻断框', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_NAME_NOT_RESOLVED' })
      .mockResolvedValueOnce({ ok: false, detail: 'timeout-15000ms' })
      .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST });
    const promptRetry = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
    expect(fetchManifest).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
    expect(promptRetry).not.toHaveBeenCalled();
  });

  it('预算用尽才弹框,reason 是最后一次的错误码', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_NAME_NOT_RESOLVED' })
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_PROXY_CONNECTION_FAILED' })
      .mockResolvedValue({ ok: false, detail: 'timeout-15000ms' });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp,
      autoRetryDelaysMs: [10, 20],
      sleep: async () => {},
    });

    expect(fetchManifest).toHaveBeenCalledTimes(3); // 首发 + 2 次自动重试
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(promptRetry).toHaveBeenCalledWith('fetch-failed:timeout-15000ms');
    expect(result).toBeNull();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('用户点重试开的新一轮同样带完整预算', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_FAILED' }) // 轮 1 首发
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_FAILED' }) // 轮 1 自动重试
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_FAILED' }) // 轮 2 首发
      .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST }); // 轮 2 自动重试
    const promptRetry = vi.fn().mockReturnValue('retry');

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10],
      sleep: async () => {},
    });

    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(fetchManifest).toHaveBeenCalledTimes(4);
    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
  });

  it.each([
    ['JSON 非法', 'not json at all'],
    ['schema 版本非法', JSON.stringify({ schemaVersion: 0 })],
    [
      '非空值非法',
      JSON.stringify({
        ...(JSON.parse(FULL_MANIFEST) as object),
        cdnBaseUrl: 'ftp://x.example.com',
      }),
    ],
  ])('%s(配置事故)不消耗重试预算,立刻弹框', async (_label, text) => {
    const fetchManifest = vi.fn<BlockingResolveDeps['fetchManifest']>().mockResolvedValue({
      ok: true,
      text,
    });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(promptRetry.mock.calls[0][0]).not.toMatch(/^fetch-failed/);
    expect(result).toBeNull();
  });

  it('missing-manifest-base-url(打包配置事故)不消耗重试预算,立刻弹框', async () => {
    const fetchManifest = vi.fn<BlockingResolveDeps['fetchManifest']>().mockResolvedValue({
      ok: false,
      detail: 'missing-manifest-base-url',
    });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it.each([403, 404, 301])('HTTP %d(永久性错误)不消耗重试预算,立刻弹框', async (status) => {
    const fetchManifest = vi.fn<BlockingResolveDeps['fetchManifest']>().mockResolvedValue({
      ok: false,
      detail: `http-${status}`,
    });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('HTTP 502(瞬时服务端错误)仍消耗重试预算', async () => {
    const fetchManifest = vi.fn<BlockingResolveDeps['fetchManifest']>().mockResolvedValue({
      ok: false,
      detail: 'http-502',
    });
    const promptRetry = vi.fn().mockReturnValue('exit');
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      autoRetryDelaysMs: [10, 20],
      sleep,
    });

    expect(fetchManifest).toHaveBeenCalledTimes(3); // 首发 + 2 次自动重试
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});

describe('getter / IPC', () => {
  it('init 之前 getClientEndpoint / getResolvedClientEndpoints 直接抛错(启动时序守卫)', () => {
    expect(() => getClientEndpoint('authApiBaseUrl')).toThrow(/not initialized/);
    expect(() => getResolvedClientEndpoints()).toThrow(/not initialized/);
  });

  it('注入解析结果后,sendSync handler 返回完整 map', () => {
    const resolved = { ...TEST_CLIENT_ENDPOINTS, websiteUrl: 'https://site.example.com' };
    resetClientEndpointsForTest(resolved);
    registerClientEndpointsIpc();
    expect(ipcOn).toHaveBeenCalledWith(CLIENT_ENDPOINTS_SYNC_CHANNEL, expect.any(Function));
    const handler = ipcOn.mock.calls[0][1] as (event: { returnValue?: unknown }) => void;
    const event: { returnValue?: unknown } = {};
    handler(event);
    expect(event.returnValue).toMatchObject({ websiteUrl: 'https://site.example.com' });
    expect(getResolvedClientEndpoints().websiteUrl).toBe('https://site.example.com');
    expect(getClientEndpoint('websiteUrl')).toBe('https://site.example.com');
  });

  it('组织会话切换所有 token 消费端点,但安装身份与更新链保持构建区域', () => {
    const cn = {
      ...TEST_CLIENT_ENDPOINTS,
      authApiBaseUrl: 'https://auth.cn.example.com',
      oauthBrokerApiBaseUrl: 'https://oauth.cn.example.com',
      deviceLinkApiBaseUrl: 'https://device.cn.example.com',
      modelAccessApiBaseUrl: 'https://model.cn.example.com',
      voiceApiBaseUrl: 'https://voice.cn.example.com',
      websiteUrl: 'https://www.cn.example.com',
      cdnBaseUrl: 'https://cdn.cn.example.com/app',
      mobileUpdateBaseUrl: 'https://update.cn.example.com',
    };
    const global = {
      ...TEST_CLIENT_ENDPOINTS,
      authApiBaseUrl: 'https://auth.global.example.com',
      oauthBrokerApiBaseUrl: 'https://oauth.global.example.com',
      deviceLinkApiBaseUrl: 'https://device.global.example.com',
      modelAccessApiBaseUrl: 'https://model.global.example.com',
      voiceApiBaseUrl: 'https://voice.global.example.com',
      websiteUrl: 'https://www.global.example.com',
      cdnBaseUrl: 'https://cdn.global.example.com/app',
      mobileUpdateBaseUrl: 'https://update.global.example.com',
    };
    resetClientEndpointsForTest(cn, {
      buildRegion: 'cn',
      realmEndpoints: { global },
    });

    expect(getClientEndpoint('authApiBaseUrl')).toBe(cn.authApiBaseUrl);
    activateClientEndpointRealm('global');
    expect(getClientEndpoint('authApiBaseUrl')).toBe(global.authApiBaseUrl);
    expect(getClientEndpoint('oauthBrokerApiBaseUrl')).toBe(global.oauthBrokerApiBaseUrl);
    expect(getClientEndpoint('deviceLinkApiBaseUrl')).toBe(global.deviceLinkApiBaseUrl);
    expect(getClientEndpoint('modelAccessApiBaseUrl')).toBe(global.modelAccessApiBaseUrl);
    expect(getClientEndpoint('voiceApiBaseUrl')).toBe(global.voiceApiBaseUrl);

    expect(getClientEndpoint('websiteUrl')).toBe(cn.websiteUrl);
    expect(getClientEndpoint('cdnBaseUrl')).toBe(cn.cdnBaseUrl);
    expect(getClientEndpoint('mobileUpdateBaseUrl')).toBe(cn.mobileUpdateBaseUrl);
    expect(getClientEndpointForRealm('global', 'cdnBaseUrl')).toBe(cn.cdnBaseUrl);

    resetClientEndpointRealm();
    expect(getClientEndpoint('authApiBaseUrl')).toBe(cn.authApiBaseUrl);
  });

  it('不依赖远端跨区字段，按构建期可信地址加载旧格式对端清单', async () => {
    resetClientEndpointsForTest(TEST_CLIENT_ENDPOINTS, {
      buildRegion: 'cn',
      realmManifestBaseUrls: {
        cn: 'https://manifest.cn.example.com/app',
        global: 'https://manifest.global.example.com/app',
      },
    });
    const globalManifest = {
      ...(JSON.parse(FULL_MANIFEST) as Record<string, unknown>),
      authApiBaseUrl: 'https://auth.global.example.com',
    };
    mockNetManifest(JSON.stringify(globalManifest));

    await expect(loadClientEndpointsForRealm('global')).resolves.toMatchObject({
      authApiBaseUrl: 'https://auth.global.example.com',
    });
    expect(netRequest).toHaveBeenCalledTimes(1);
    expect(netRequest).toHaveBeenCalledWith(
      expect.stringMatching(
        /^https:\/\/manifest\.global\.example\.com\/app\/endpoint\.json\?t=\d+$/,
      ),
    );
  });

  it('对端清单自报 region 时必须与目标区域一致，拒绝后不污染缓存', async () => {
    resetClientEndpointsForTest(TEST_CLIENT_ENDPOINTS, {
      buildRegion: 'cn',
      realmManifestBaseUrls: {
        cn: 'https://manifest.cn.example.com/app',
        global: 'https://manifest.global.example.com/app',
      },
    });
    const globalManifest = {
      ...(JSON.parse(FULL_MANIFEST) as Record<string, unknown>),
      authApiBaseUrl: 'https://auth.global.example.com',
    };
    mockNetManifest(JSON.stringify({ ...globalManifest, region: 'cn' }));
    mockNetManifest(JSON.stringify(globalManifest));

    await expect(loadClientEndpointsForRealm('global')).rejects.toThrow(
      'region-mismatch:global:cn',
    );
    await expect(loadClientEndpointsForRealm('global')).resolves.toMatchObject({
      authApiBaseUrl: 'https://auth.global.example.com',
    });
    expect(netRequest).toHaveBeenCalledTimes(2);
  });
});
