/**
 * clientEndpointsService 单测(规则 14:依赖注入 + 内存 harness)。
 *
 * 校验语义(缺省字段归一/协议白名单/allowHttp)在 @cindy/maker-shared 侧已覆盖;
 * 这里只测 desktop 宿主层:清单来源解析(resolveEndpointSource 表驱动)、
 * 阻断式重试循环(失败 → prompt → 重试/退出,无静默降级、无烘焙合并)、
 * file 模式的 allowHttp 放行、init 前 getter 抛错(启动时序守卫)、sendSync IPC 形状。
 */
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEST_CLIENT_ENDPOINTS } from '../../test/vitest/clientEndpointsFixture';

const ipcOn = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getAppPath: vi.fn(() => '/repo/apps/desktop'), isPackaged: false, exit: vi.fn() },
  dialog: { showMessageBoxSync: vi.fn() },
  ipcMain: { on: ipcOn },
  net: { request: vi.fn() },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  getClientEndpoint,
  getResolvedClientEndpoints,
  registerClientEndpointsIpc,
  resetClientEndpointsForTest,
  resolveClientEndpointsBlocking,
  resolveEndpointSource,
  CLIENT_ENDPOINTS_SYNC_CHANNEL,
} from '../clientEndpointsService';

afterEach(() => {
  resetClientEndpointsForTest();
  ipcOn.mockClear();
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
    ['dev 默认读仓内 cn 正本', { isPackaged: false, env: {} }, { kind: 'file', filePath: DEFAULT_FILE }],
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

describe('resolveClientEndpointsBlocking(阻断循环,清单即唯一事实源)', () => {
  it('首次成功:不进 prompt,所有值来自清单', async () => {
    const promptRetry = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifestText: async () => FULL_MANIFEST,
      promptRetry,
      exitApp: vi.fn(),
    });
    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
    expect(result?.cdnBaseUrl).toBe('https://cdn.remote.example.com/app');
    expect(promptRetry).not.toHaveBeenCalled();
  });

  it('失败 → prompt 选重试 → 第二次成功(无静默降级)', async () => {
    const fetchManifestText = vi
      .fn<(timeoutMs: number) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(FULL_MANIFEST);
    const promptRetry = vi.fn().mockReturnValue('retry');
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifestText,
      promptRetry,
      exitApp,
    });
    expect(promptRetry).toHaveBeenCalledTimes(1);
    expect(promptRetry).toHaveBeenCalledWith('fetch-failed');
    expect(fetchManifestText).toHaveBeenCalledTimes(2);
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
      fetchManifestText: async () => JSON.stringify(manifest),
      promptRetry,
      exitApp,
    });
    expect(result?.heartbeatUrl).toBe('');
    expect(promptRetry).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('fetch 抛错视同失败进 prompt,选退出返回 null', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();
    const result = await resolveClientEndpointsBlocking({
      fetchManifestText: async () => {
        throw new Error('boom');
      },
      promptRetry,
      exitApp,
    });
    expect(result).toBeNull();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('localhost http 清单:默认拒绝(CDN 路径零放松),allowHttp(file 模式)放行', async () => {
    const rejected = await resolveClientEndpointsBlocking({
      fetchManifestText: async () => LOCAL_MANIFEST,
      promptRetry: vi.fn().mockReturnValue('exit'),
      exitApp: vi.fn(),
    });
    expect(rejected).toBeNull();

    const accepted = await resolveClientEndpointsBlocking({
      fetchManifestText: async () => LOCAL_MANIFEST,
      promptRetry: vi.fn(),
      exitApp: vi.fn(),
      allowHttp: true,
    });
    expect(accepted?.authApiBaseUrl).toBe('http://localhost:3344');
  });

  it('文件缺失(读取返回 null)进同一条阻断链路', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const result = await resolveClientEndpointsBlocking({
      fetchManifestText: async () => null, // file 模式读不到文件即返回 null
      promptRetry,
      exitApp: vi.fn(),
      allowHttp: true,
    });
    expect(result).toBeNull();
    expect(promptRetry).toHaveBeenCalledWith('fetch-failed');
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
});
