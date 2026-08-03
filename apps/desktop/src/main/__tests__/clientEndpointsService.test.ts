/**
 * clientEndpointsService 单测(规则 14:依赖注入 + 内存 harness)。
 *
 * 校验语义(缺省字段归一/协议白名单/allowHttp)在 @cindy/maker-shared 侧已覆盖;
 * 这里只测 desktop 宿主层:清单来源解析(resolveEndpointSource 表驱动)、
 * 阻断式重试循环(失败 → prompt → 重试/退出,无静默降级、无烘焙合并)、
 * 弹框前的网络层自动重试(mac 首装瞬时失败自愈;配置事故不消耗预算)、
 * 失败 reason 带错误码、失败分类(network / config)、
 * 弹框前的分阶段诊断调用时机、
 * **用户显式确认的离线出口**(仅网络层失败给,配置事故绝不给)、
 * file 模式的 allowHttp 放行、init 前 getter 抛错(启动时序守卫)、sendSync IPC 形状。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_CLIENT_ENDPOINTS } from '../../test/vitest/clientEndpointsFixture';

const ipcOn = vi.hoisted(() => vi.fn());
const netRequest = vi.hoisted(() => vi.fn());
const showMessageBoxSync = vi.hoisted(() => vi.fn());
const clipboardWriteText = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(),
    getAppPath: vi.fn(() => '/repo/apps/desktop'),
    isPackaged: false,
    exit: vi.fn(),
  },
  dialog: { showMessageBoxSync },
  clipboard: { writeText: clipboardWriteText },
  ipcMain: { on: ipcOn },
  net: { request: netRequest },
  // netLog 是静态 import(architecture-invariants.md §2);captureEndpointNetLog 这条
  // 路径由 captureNetLogAround 的注入式用例覆盖,这里只需让模块能加载。
  netLog: { startLogging: vi.fn(async () => {}), stopLogging: vi.fn(async () => {}) },
  session: { defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT') } },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogDir: () => '/tmp/cindy-test-logs',
}));

import {
  activateClientEndpointRealm,
  captureNetLogAround,
  prepareEndpointNetLogFile,
  promptRetryDialog,
  verifyEndpointNetLogCapture,
  classifyManifestFailure,
  getClientEndpoint,
  getClientEndpointForRealm,
  getResolvedClientEndpoints,
  loadClientEndpointsForRealm,
  isUsingCachedClientEndpoints,
  registerClientEndpointsIpc,
  resetClientEndpointRealm,
  resetClientEndpointsForTest,
  resolveClientEndpointsBlocking,
  resolveEndpointSource,
  CLIENT_ENDPOINTS_SYNC_CHANNEL,
  type BlockingResolveDeps,
  type ManifestPromptContext,
} from '../clientEndpointsService';

afterEach(() => {
  resetClientEndpointsForTest();
  ipcOn.mockClear();
  netRequest.mockReset();
  showMessageBoxSync.mockReset();
  clipboardWriteText.mockReset();
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

describe('启动失败系统提示框', () => {
  it('使用友好警告文案并展示简短错误信息,但不展示地址、网络诊断或本机路径', () => {
    showMessageBoxSync.mockReturnValueOnce(0);

    const choice = promptRetryDialog(
      {
        reason: 'fetch-failed:ERR_CONNECTION_RESET',
        kind: 'network',
        diagnosis: 'proxy=DIRECT dns=ok(43.146.61.38) tcp=ok(12ms)',
        logPath: '/Users/example/Library/Logs/Cindy/endpoint-netlog/capture.json',
        offlineSavedAt: null,
      },
      'https://hotfix.cindy.app/cindy/endpoint.json',
      'zh-CN',
    );

    expect(choice).toBe('retry');
    expect(showMessageBoxSync).toHaveBeenCalledTimes(1);
    const options = showMessageBoxSync.mock.calls[0]?.[0] as {
      type: string;
      message: string;
      detail: string;
      buttons: string[];
    };
    const visibleText = `${options.message}\n${options.detail}\n${options.buttons.join('\n')}`;
    expect(options.type).toBe('warning');
    expect(options.message).toBe('Cindy 暂时无法连接');
    expect(visibleText).toContain('请确认设备已联网');
    expect(visibleText).toContain('错误信息：ERR_CONNECTION_RESET');
    expect(visibleText).toContain('复制诊断信息');
    expect(visibleText).not.toContain('截图');
    expect(visibleText).not.toContain('CINDY-NET-');
    expect(visibleText).not.toContain('43.146.61.38');
    expect(visibleText).not.toContain('proxy=DIRECT');
    expect(visibleText).not.toContain('/Users/example');
  });

  it('复制诊断后保留弹框,不触发重试或退出,并显示已复制反馈', () => {
    showMessageBoxSync.mockReturnValueOnce(1).mockReturnValueOnce(0);

    const choice = promptRetryDialog(
      {
        reason: 'fetch-failed:ERR_CONNECTION_RESET',
        kind: 'network',
        diagnosis: 'proxy=DIRECT dns=ok(43.146.61.38) tcp=ok(12ms)',
        logPath: '/Users/example/Library/Logs/Cindy/endpoint-netlog/capture.json',
        offlineSavedAt: null,
      },
      'https://hotfix.cindy.app/cindy/endpoint.json',
      'zh-CN',
    );

    expect(choice).toBe('retry');
    expect(showMessageBoxSync).toHaveBeenCalledTimes(2);
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(clipboardWriteText.mock.calls[0]?.[0]).toContain('ERR_CONNECTION_RESET');
    expect(clipboardWriteText.mock.calls[0]?.[0]).toContain('hotfix.cindy.app');
    expect(clipboardWriteText.mock.calls[0]?.[0]).toContain('proxy=DIRECT');
    expect(clipboardWriteText.mock.calls[0]?.[0]).toContain('/Users/example');
    expect(showMessageBoxSync.mock.calls[1]?.[0].detail).toContain('诊断信息已复制');
  });

  it('复制诊断失败时在弹框内明确提示,不误报为已复制', () => {
    showMessageBoxSync.mockReturnValueOnce(1).mockReturnValueOnce(0);
    clipboardWriteText.mockImplementationOnce(() => {
      throw new Error('clipboard unavailable');
    });

    const choice = promptRetryDialog(
      {
        reason: 'fetch-failed:ERR_CONNECTION_RESET',
        kind: 'network',
        diagnosis: 'proxy=DIRECT dns=ok(43.146.61.38) tcp=ok(12ms)',
        logPath: '/Users/example/Library/Logs/Cindy/endpoint-netlog/capture.json',
        offlineSavedAt: null,
      },
      'https://hotfix.cindy.app/cindy/endpoint.json',
      'zh-CN',
    );

    expect(choice).toBe('retry');
    expect(showMessageBoxSync).toHaveBeenCalledTimes(2);
    expect(showMessageBoxSync.mock.calls[1]?.[0].detail).toContain('诊断信息未能复制');
    expect(showMessageBoxSync.mock.calls[1]?.[0].detail).not.toContain('诊断信息已复制');
  });
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

/** promptRetry 现在收整个上下文对象;断言只钉住 reason 与失败分类。 */
const promptedWith = (reason: string, kind: 'network' | 'config' = 'network') =>
  expect.objectContaining({ reason, kind });

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
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('region-mismatch:cn:global', 'config'));

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
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:ERR_CONNECTION_REFUSED'));
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
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:ERR_NAME_NOT_RESOLVED'));
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
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed'));
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
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:ENOENT'));
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
    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:timeout-15000ms'));
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
    expect(promptRetry.mock.calls[0][0].reason).not.toMatch(/^fetch-failed/);
    expect(promptRetry.mock.calls[0][0].kind).toBe('config');
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

  it.each([407, 408, 425, 429])(
    '非配置错 HTTP %d 仍消耗重试预算(与分类共用同一判定)',
    async (status) => {
      const fetchManifest = vi.fn<BlockingResolveDeps['fetchManifest']>().mockResolvedValue({
        ok: false,
        detail: `http-${status}`,
      });
      const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

      await resolveClientEndpointsBlocking({
        fetchManifest,
        promptRetry: vi.fn().mockReturnValue('exit'),
        exitApp: vi.fn(),
        autoRetryDelaysMs: [10, 20],
        sleep,
      });

      expect(fetchManifest).toHaveBeenCalledTimes(3); // 首发 + 2 次自动重试
      expect(sleep).toHaveBeenCalledTimes(2);
    },
  );

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

describe('失败分类与弹框前诊断', () => {
  it.each([
    ['fetch-failed', 'network'],
    ['fetch-failed:ERR_FAILED', 'network'],
    ['fetch-failed:timeout-15000ms', 'network'],
    // 5xx 可能是瞬时故障:重试循环会重试,这里也给离线出口。
    ['fetch-failed:http-500', 'network'],
    ['fetch-failed:http-502', 'network'],
    // 瞬时 4xx:限流 / 请求超时过一会儿就好,不能当配置事故——那会让一个正被限流的
    // 用户既不能重试、又用不上手里那份可用缓存。
    ['fetch-failed:http-408', 'network'],
    ['fetch-failed:http-425', 'network'],
    ['fetch-failed:http-429', 'network'],
    // 407 按 RFC 9110 §15.5.8 只可能来自代理,描述的是本机网络环境(代理凭据缺失/
    // 过期)而不是清单部署错;公司代理没登录恰恰是离线出口最该生效的场景。
    ['fetch-failed:http-407', 'network'],
    // 永久性 HTTP = 路径 / 权限 / 部署配置错。重试循环已因此不重试,分类必须一致,
    // 否则同一失败会"配置错所以不重试"又"网络问题所以能用缓存绕过"。
    ['fetch-failed:http-301', 'config'],
    ['fetch-failed:http-403', 'config'],
    ['fetch-failed:http-404', 'config'],
    ['fetch-failed:http-451', 'config'],
    ['fetch-failed:missing-manifest-base-url', 'config'],
    ['invalid-json', 'config'],
    ['unsupported-schema-version:9', 'config'],
    ['invalid-protocol:cdnBaseUrl', 'config'],
    ['region-mismatch:cn:global', 'config'],
  ] as const)('%s → %s', (reason, kind) => {
    expect(classifyManifestFailure(reason)).toBe(kind);
  });

  it('网络失败时诊断摘要与日志路径进 prompt 上下文', async () => {
    const diagnose = vi.fn().mockResolvedValue({
      summary: 'proxy=DIRECT dns=ok(1.2.3.4) tcp=ok(9ms)',
      logPath: '/tmp/cindy-test-logs/endpoint-netlog.json',
    });
    const promptRetry = vi.fn().mockReturnValue('exit');

    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry,
      exitApp: vi.fn(),
      diagnose,
      ...NO_AUTO_RETRY,
    });

    // 一轮只诊断一次(自动重试期间不诊断,别把弹框前的等待翻倍)。
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(promptRetry.mock.calls[0][0]).toMatchObject({
      kind: 'network',
      diagnosis: 'proxy=DIRECT dns=ok(1.2.3.4) tcp=ok(9ms)',
      logPath: '/tmp/cindy-test-logs/endpoint-netlog.json',
    });
  });

  it('配置事故不跑诊断(探网络没有信息量)', async () => {
    const diagnose = vi.fn();
    const promptRetry = vi.fn().mockReturnValue('exit');

    await resolveClientEndpointsBlocking({
      fetchManifest: okFetch('not json'),
      promptRetry,
      exitApp: vi.fn(),
      diagnose,
    });

    expect(diagnose).not.toHaveBeenCalled();
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ diagnosis: null, logPath: null });
  });

  it('烘焙基址缺失不跑诊断(空 URL 探不出东西)', async () => {
    const diagnose = vi.fn();
    const promptRetry = vi.fn().mockReturnValue('exit');

    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('missing-manifest-base-url'),
      promptRetry,
      exitApp: vi.fn(),
      diagnose,
    });

    expect(diagnose).not.toHaveBeenCalled();
  });

  it('file 模式覆写分类:本地读不到不该让人去检查网络', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const diagnose = vi.fn();
    const loadOfflineManifest = vi.fn();

    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ENOENT'),
      promptRetry,
      exitApp: vi.fn(),
      allowHttp: true,
      classifyFailure: () => 'config',
      diagnose,
      loadOfflineManifest,
      ...NO_AUTO_RETRY,
    });

    expect(promptRetry).toHaveBeenCalledWith(promptedWith('fetch-failed:ENOENT', 'config'));
    expect(diagnose).not.toHaveBeenCalled();
    expect(loadOfflineManifest).not.toHaveBeenCalled();
  });

  it('诊断永不返回时按兜底 deadline 放弃,阻断框照样弹出', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();
    const startedAt = Date.now();

    const result = await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry,
      exitApp,
      // diagnose 是注入点:实现方忘了设超时不能让启动永久停在这里。
      diagnose: () => new Promise(() => {}),
      diagnosisBudgetMs: 30,
      ...NO_AUTO_RETRY,
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ diagnosis: null, logPath: null });
    expect(result).toBeNull();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it('诊断自身抛错不影响阻断流程', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const exitApp = vi.fn();

    const result = await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry,
      exitApp,
      diagnose: async () => {
        throw new Error('probe blew up');
      },
      ...NO_AUTO_RETRY,
    });

    expect(result).toBeNull();
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ diagnosis: null });
    expect(exitApp).toHaveBeenCalledTimes(1);
  });
});

describe('用户确认的离线出口', () => {
  const offlineCandidate = () => ({
    parsed: {
      ok: true as const,
      endpoints: { ...TEST_CLIENT_ENDPOINTS, authApiBaseUrl: 'https://auth.cached.example.com' },
      reviewVersion: null,
      region: null,
    },
    savedAt: '2026/7/29 06:22',
  });

  it('网络失败 + 有缓存 + 用户点离线 → 用缓存端点启动', async () => {
    const loadOfflineManifest = vi.fn(offlineCandidate);
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValue({ ok: false, detail: 'ERR_FAILED' });
    const promptRetry = vi.fn().mockReturnValue('offline');
    const exitApp = vi.fn();

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp,
      loadOfflineManifest,
      ...NO_AUTO_RETRY,
    });

    expect(result?.authApiBaseUrl).toBe('https://auth.cached.example.com');
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ offlineSavedAt: '2026/7/29 06:22' });
    expect(exitApp).not.toHaveBeenCalled();
    // 只尝试了一次网络:离线是出口而不是"再试一次"。
    expect(fetchManifest).toHaveBeenCalledTimes(1);
  });

  it('走离线出口时 onResolved 收到 source=cache;网络成功则是 network 并带原文', async () => {
    const cacheResolved = vi.fn();
    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry: () => 'offline',
      exitApp: vi.fn(),
      loadOfflineManifest: offlineCandidate,
      onResolved: cacheResolved,
      ...NO_AUTO_RETRY,
    });
    expect(cacheResolved).toHaveBeenCalledWith(expect.anything(), 'cache');

    const netResolved = vi.fn();
    await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(FULL_MANIFEST),
      promptRetry: vi.fn(),
      exitApp: vi.fn(),
      loadOfflineManifest: offlineCandidate,
      onResolved: netResolved,
    });
    // 第三个参数必须是**校验通过的原文本身**:宿主要拿它原样落缓存,不能重新序列化
    // (重新序列化会抹掉本构建还不认识的新字段,升级后离线启动就丢配置)。
    expect(netResolved).toHaveBeenCalledWith(expect.anything(), 'network', FULL_MANIFEST);
  });

  it('清单带本构建未知字段时,原文照样原样交给宿主落缓存', async () => {
    const withUnknownField = JSON.stringify({
      ...(JSON.parse(FULL_MANIFEST) as object),
      // 前向兼容的发布模型:先上新字段的清单,再发认识它的客户端。
      futureApiBaseUrl: 'https://future.remote.example.com',
    });
    const onResolved = vi.fn();

    await resolveClientEndpointsBlocking({
      fetchManifest: okFetch(withUnknownField),
      promptRetry: vi.fn(),
      exitApp: vi.fn(),
      onResolved,
    });

    expect(onResolved.mock.calls[0][2]).toBe(withUnknownField);
    expect(onResolved.mock.calls[0][2]).toContain('futureApiBaseUrl');
  });

  it.each([301, 403, 404])(
    '永久性 HTTP %d 不给离线出口(与"不重试"的判定保持一致)',
    async (status) => {
      const loadOfflineManifest = vi.fn(offlineCandidate);
      const diagnose = vi.fn();
      const promptRetry = vi.fn().mockReturnValue('exit');

      await resolveClientEndpointsBlocking({
        fetchManifest: failFetch(`http-${status}`),
        promptRetry,
        exitApp: vi.fn(),
        loadOfflineManifest,
        diagnose,
      });

      expect(loadOfflineManifest).not.toHaveBeenCalled();
      expect(diagnose).not.toHaveBeenCalled();
      expect(promptRetry.mock.calls[0][0]).toMatchObject({
        kind: 'config',
        offlineSavedAt: null,
      });
    },
  );

  it.each([407, 408, 429])(
    '非配置错 HTTP %d 仍给离线出口(代理没登录/被限流不该连缓存都用不上)',
    async (status) => {
      const promptRetry = vi.fn().mockReturnValue('offline');

      const result = await resolveClientEndpointsBlocking({
        fetchManifest: failFetch(`http-${status}`),
        promptRetry,
        exitApp: vi.fn(),
        loadOfflineManifest: offlineCandidate,
        ...NO_AUTO_RETRY,
      });

      expect(result?.authApiBaseUrl).toBe('https://auth.cached.example.com');
      expect(promptRetry.mock.calls[0][0]).toMatchObject({ kind: 'network' });
    },
  );

  it('HTTP 502(瞬时)仍给离线出口', async () => {
    const loadOfflineManifest = vi.fn(offlineCandidate);
    const promptRetry = vi.fn().mockReturnValue('offline');

    const result = await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('http-502'),
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest,
      ...NO_AUTO_RETRY,
    });

    expect(result?.authApiBaseUrl).toBe('https://auth.cached.example.com');
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ kind: 'network' });
  });

  it('配置事故绝不给离线出口:既不读缓存也不点亮按钮', async () => {
    const loadOfflineManifest = vi.fn(offlineCandidate);
    const promptRetry = vi.fn().mockReturnValue('exit');

    await resolveClientEndpointsBlocking({
      fetchManifest: okFetch('not json'),
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest,
    });

    expect(loadOfflineManifest).not.toHaveBeenCalled();
    expect(promptRetry.mock.calls[0][0]).toMatchObject({
      kind: 'config',
      offlineSavedAt: null,
    });
  });

  it('没有可用缓存时 offlineSavedAt 为 null(弹框不出离线按钮)', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest: () => null,
      ...NO_AUTO_RETRY,
    });
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ offlineSavedAt: null });
  });

  it('读缓存抛错只降级为"没有缓存"', async () => {
    const promptRetry = vi.fn().mockReturnValue('exit');
    const result = await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest: () => {
        throw new Error('disk on fire');
      },
      ...NO_AUTO_RETRY,
    });
    expect(result).toBeNull();
    expect(promptRetry.mock.calls[0][0]).toMatchObject({ offlineSavedAt: null });
  });

  it('选了离线但缓存这一瞬失效 → 回到下一轮尝试,不静默继续', async () => {
    const fetchManifest = vi
      .fn<BlockingResolveDeps['fetchManifest']>()
      .mockResolvedValueOnce({ ok: false, detail: 'ERR_FAILED' })
      .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST });
    // 第一轮报告有缓存,用户点离线时缓存已经不可用(被清理 / 校验不过)。
    const loadOfflineManifest = vi
      .fn<NonNullable<BlockingResolveDeps['loadOfflineManifest']>>()
      .mockReturnValueOnce(null);
    const promptRetry = vi
      .fn<(context: ManifestPromptContext) => 'retry' | 'offline' | 'exit'>()
      .mockReturnValue('offline');

    const result = await resolveClientEndpointsBlocking({
      fetchManifest,
      promptRetry,
      exitApp: vi.fn(),
      loadOfflineManifest,
      ...NO_AUTO_RETRY,
    });

    expect(result?.authApiBaseUrl).toBe('https://auth.remote.example.com');
    expect(fetchManifest).toHaveBeenCalledTimes(2);
  });

  it('自动重试期间不问缓存(只在真要弹框时读一次盘)', async () => {
    const loadOfflineManifest = vi.fn(offlineCandidate);
    await resolveClientEndpointsBlocking({
      fetchManifest: failFetch('ERR_FAILED'),
      promptRetry: () => 'exit',
      exitApp: vi.fn(),
      loadOfflineManifest,
      autoRetryDelaysMs: [1, 2],
      sleep: async () => {},
    });
    expect(loadOfflineManifest).toHaveBeenCalledTimes(1);
  });
});

describe('netlog 抓取(captureNetLogAround)', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('正常路径:返回文件路径,start/stop 配对', async () => {
    const startLogging = vi.fn(async () => {});
    const stopLogging = vi.fn(async () => {});
    const run = vi.fn(async () => {});

    const file = await captureNetLogAround({ startLogging, stopLogging }, '/tmp/n.json', run, 50);

    expect(file).toBe('/tmp/n.json');
    expect(startLogging).toHaveBeenCalledWith('/tmp/n.json', { captureMode: 'default' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(stopLogging).toHaveBeenCalledTimes(1);
  });

  it('录制期间的请求抛错也照样 stop,并仍返回路径', async () => {
    const stopLogging = vi.fn(async () => {});
    const file = await captureNetLogAround(
      { startLogging: async () => {}, stopLogging },
      '/tmp/n.json',
      async () => {
        throw new Error('fetch blew up');
      },
      50,
    ).catch(() => 'threw');

    // runWhileRecording 的异常向上抛,但 finally 里的 stop 必须已经发出。
    expect(file).toBe('threw');
    expect(stopLogging).toHaveBeenCalledTimes(1);
  });

  it('stop 超时不会锁死收尾:迟到成功的 start 仍会再尝试停止', async () => {
    // 上一版一进 stopOnce 就把 stopped 置 true,于是 stop 超时后就再也不试了——
    // 而 withDeadline 取消不了 Electron 侧操作,没停下的进程级抓包会继续录流量。
    const gate = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();
    let stopCalls = 0;
    const stopLogging = vi.fn(async () => {
      stopCalls += 1;
      if (stopCalls <= 2) return new Promise(() => {}); // 前两次(有界重试)都不 settle
      return undefined;
    });

    const file = await captureNetLogAround(
      { startLogging: () => gate.promise, stopLogging },
      '/tmp/n.json',
      async () => {},
      10,
    );
    expect(file).toBeNull(); // start 超时,本次放弃 netlog

    gate.resolve(); // start 迟到成功 → 必须补一次 stop
    await new Promise((r) => setTimeout(r, 60));
    expect(stopCalls).toBeGreaterThanOrEqual(1);
  });

  it('stop 在预算内失败时有界重试(不无限试)', async () => {
    let calls = 0;
    const stopLogging = vi.fn(async () => {
      calls += 1;
      throw new Error('stop boom');
    });
    const file = await captureNetLogAround(
      { startLogging: async () => {}, stopLogging },
      '/tmp/n.json',
      async () => {},
      20,
    );
    expect(file).toBe('/tmp/n.json');
    expect(calls).toBe(2); // NETLOG_STOP_ATTEMPTS
  });

  it('前台重试耗尽后由后台定时重试兜底,直到确认停止', async () => {
    // review 抓到:前台重试有界,耗尽后如果没有新的触发点,一次没停下的**进程级**抓包
    // 就会继续录启动后的全部流量、文件无界增长。后台重试不占启动路径,但保证有人收尾。
    vi.useFakeTimers();
    try {
      let calls = 0;
      const stopLogging = vi.fn(async () => {
        calls += 1;
        if (calls < 4) throw new Error('stop boom');
        return undefined;
      });

      const pending = captureNetLogAround(
        { startLogging: async () => {}, stopLogging },
        '/tmp/n.json',
        async () => {},
        20,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toBe('/tmp/n.json');
      expect(calls).toBe(2); // 前台预算就此用尽,启动流程不再多等

      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(3); // 后台第 1 次
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(4); // 后台第 2 次成功
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls).toBe(4); // 停下之后不再排下一次
    } finally {
      vi.useRealTimers();
    }
  });

  it('后台重试不设次数上限:节奏放缓但一直盯到确认停止', async () => {
    // review 抓到:给后台重试设 12 次上限,等于"NetworkService 卡过一分钟再恢复"时
    // 抓包在无人收尾的状态下录满整个进程生命周期 —— 正是这条兜底要防的事。
    vi.useFakeTimers();
    try {
      let logging = true;
      const stopLogging = vi.fn(async () => {
        if (logging) throw new Error('stop boom');
        return undefined;
      });
      const netLogApi = {
        startLogging: async () => {},
        stopLogging,
        get currentlyLogging() {
          return logging;
        },
      };
      const pending = captureNetLogAround(netLogApi, '/tmp/n.json', async () => {}, 20);
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(stopLogging).toHaveBeenCalledTimes(2); // 前台预算

      // 快节奏 6 次 + 慢节奏 6 次都失败之后,仍然有下一个触发点。
      await vi.advanceTimersByTimeAsync(6 * 5_000 + 6 * 30_000);
      const afterFastPhase = stopLogging.mock.calls.length;
      expect(afterFastPhase).toBe(2 + 12);
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(stopLogging.mock.calls.length).toBeGreaterThan(afterFastPhase);

      // NetworkService 恢复后:确认停止,循环收手。
      logging = false;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      const settled = stopLogging.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(stopLogging.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('currentlyLogging=false 时不空转重试', async () => {
    const stopLogging = vi.fn(async () => {});
    const file = await captureNetLogAround(
      { startLogging: async () => {}, stopLogging, currentlyLogging: false },
      '/tmp/n.json',
      async () => {},
      20,
    );
    expect(file).toBe('/tmp/n.json');
    expect(stopLogging).not.toHaveBeenCalled();
  });

  it('stop 永不返回时不卡住,仍返回文件路径', async () => {
    const startedAt = Date.now();
    const file = await captureNetLogAround(
      { startLogging: async () => {}, stopLogging: () => new Promise(() => {}) },
      '/tmp/n.json',
      async () => {},
      20,
    );
    expect(file).toBe('/tmp/n.json');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('start 迟到成功时补发 stop(否则进程级抓包无人收尾、文件无界增长)', async () => {
    const gate = deferred();
    const stopLogging = vi.fn(async () => {});
    const run = vi.fn(async () => {});

    const file = await captureNetLogAround(
      { startLogging: () => gate.promise, stopLogging },
      '/tmp/n.json',
      run,
      10,
    );

    // 超时先到:本次诊断放弃 netlog。
    expect(file).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(stopLogging).not.toHaveBeenCalled();

    // start 之后才成功 —— withDeadline 只解除等待,不取消 Electron 侧操作,
    // 所以这里必须补一次 stop,否则抓包会一直录后续所有应用流量。
    gate.resolve();
    await new Promise((r) => setImmediate(r));
    expect(stopLogging).toHaveBeenCalledTimes(1);
  });

  it('start 迟到失败时不补发 stop(没有 capture 需要关闭)', async () => {
    let reject!: (err: Error) => void;
    const startPromise = new Promise<void>((_r, rj) => {
      reject = rj;
    });
    const stopLogging = vi.fn(async () => {});

    const file = await captureNetLogAround(
      { startLogging: () => startPromise, stopLogging },
      '/tmp/n.json',
      async () => {},
      10,
    );
    expect(file).toBeNull();

    reject(new Error('start failed late'));
    await new Promise((r) => setImmediate(r));
    expect(stopLogging).not.toHaveBeenCalled();
  });
});

describe('netlog 落盘路径(不得落到 cwd、不得用可预测名)', () => {
  let logDir: string;
  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-netlog-'));
  });
  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it.each([
    ['null(logger 未初始化)', null],
    ['空串(initLogger 建目录失败时的实际取值)', ''],
    ['纯空白', '   '],
  ])('%s → null,调用方跳过抓取', (_label, dir) => {
    // path.join('', name) 会得到相对路径,落到 process.cwd()——dev 下正是仓库工作区,
    // 会在被 Git 跟踪的目录里留生成物。
    expect(prepareEndpointNetLogFile(dir)).toBeNull();
  });

  it('落在一个新建的私有子目录里(交接期路径不可被替换)', () => {
    const file = prepareEndpointNetLogFile(logDir)!.file;
    expect(file).not.toBeNull();
    expect(path.isAbsolute(file)).toBe(true);

    const captureDir = path.dirname(file);
    // 不是直接落在日志目录里,而是落在我们刚原子创建的随机名子目录里。
    expect(captureDir).not.toBe(logDir);
    expect(path.dirname(captureDir)).toBe(logDir);
    expect(path.basename(captureDir).startsWith('endpoint-netlog-')).toBe(true);
    expect(fs.lstatSync(captureDir).isDirectory()).toBe(true);
    // 文件本身刻意不预创建:交给 Chromium 在这个私有目录里建,
    // 所以不存在「独占创建后 close、Chromium 再按名字打开」那段可替换窗口。
    expect(fs.existsSync(file)).toBe(false);
  });

  it('私有目录仅属主可访问(POSIX)', () => {
    if (process.platform === 'win32') return; // Windows 权限模型不同,目录名随机仍有效
    const file = prepareEndpointNetLogFile(logDir)!.file;
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('目录名不可预测,两次调用不同目录', () => {
    const a = prepareEndpointNetLogFile(logDir)!.file;
    const b = prepareEndpointNetLogFile(logDir)!.file;
    expect(path.dirname(a)).not.toBe(path.dirname(b));
  });

  it('每次准备前清掉本前缀旧产物(旧目录 + 两个历史版本的文件名)', () => {
    // 第一版固定名与第二版唯一名的残留都要被清掉,否则唯一名会无界堆积。
    fs.writeFileSync(path.join(logDir, 'endpoint-netlog.json'), 'v1', 'utf8');
    fs.writeFileSync(path.join(logDir, `endpoint-netlog.${process.pid}.abc123.json`), 'v2', 'utf8');
    const first = prepareEndpointNetLogFile(logDir)!.file;
    const second = prepareEndpointNetLogFile(logDir)!.file;

    const left = fs.readdirSync(logDir).filter((n) => n.startsWith('endpoint-netlog'));
    expect(left).toEqual([path.basename(path.dirname(second))]);
    expect(fs.existsSync(path.dirname(first))).toBe(false);
  });

  it('目录不存在时返回 null,不抛错', () => {
    expect(prepareEndpointNetLogFile(path.join(logDir, 'missing'))).toBeNull();
  });

  it('日志目录 group/other 可写时跳过抓取(别的用户能抢目录项)', () => {
    // 0700 子目录只保护内容,保护不了它在父目录里的目录项:父目录对别人可写,
    // 别的用户就能把它 rename 掉、换上 symlink,把 Chromium 引到别处。
    if (process.platform === 'win32') return; // Windows 用 ACL,mode 位判断无意义
    fs.chmodSync(logDir, 0o777);
    expect(prepareEndpointNetLogFile(logDir)).toBeNull();
    fs.chmodSync(logDir, 0o700);
    expect(prepareEndpointNetLogFile(logDir)).not.toBeNull();
  });

  it('日志"目录"其实是文件时跳过抓取', () => {
    const asFile = path.join(logDir, 'not-a-dir');
    fs.writeFileSync(asFile, 'x', 'utf8');
    expect(prepareEndpointNetLogFile(asFile)).toBeNull();
  });
});

describe('netlog 产物事后核对(verifyEndpointNetLogCapture)', () => {
  let logDir: string;
  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-netlog-verify-'));
  });
  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('目录项没被换过、目标是常规文件 → 通过', () => {
    const capture = prepareEndpointNetLogFile(logDir)!;
    fs.writeFileSync(capture.file, '{}', 'utf8'); // 模拟 Chromium 写出的产物
    expect(verifyEndpointNetLogCapture(capture)).toBe(true);
  });

  it('目录项被换成 symlink → 不通过(产物丢弃)', () => {
    // 这是攻击的真实形状:把我们创建的目录项换成指向别处的 symlink,好让 Chromium
    // 写到别的地方去。lstat 不跟随 symlink,所以 isDirectory() 为 false。
    if (process.platform === 'win32') return;
    const capture = prepareEndpointNetLogFile(logDir)!;
    const captureDir = path.dirname(capture.file);
    const elsewhere = fs.mkdtempSync(path.join(logDir, 'elsewhere-'));
    fs.rmSync(captureDir, { recursive: true, force: true });
    fs.symlinkSync(elsewhere, captureDir);
    fs.writeFileSync(capture.file, '{}', 'utf8');
    expect(verifyEndpointNetLogCapture(capture)).toBe(false);
  });

  it('目录项换成了别的 inode → 不通过', () => {
    // 用改过的 dirIno 直接表达"目录项已经不是我们创建的那个 inode"。
    // 不通过 rm + mkdir 复现:那样在 ext4 上常常**复用同一个 inode 号**,断言会随文件
    // 系统摇摆(CI 上就是这么红的)。inode 号复用也正是这道核对的已知局限:
    // 它能抓住 symlink / 类型变化,抓不住"号被回收后重建"。
    const capture = prepareEndpointNetLogFile(logDir)!;
    fs.writeFileSync(capture.file, '{}', 'utf8');
    // Windows 可能把 ino 暴露为 0；生产逻辑会有意跳过无法执行的 inode 身份核对。
    if (!capture.dirIno) return;
    // 不用 +1：Windows 的 inode 可能超过 Number.MAX_SAFE_INTEGER，+1 后数值仍相等。
    const otherIno = capture.dirIno === 1 ? 2 : 1;
    const otherDev = capture.dirDev === 1 ? 2 : 1;
    expect(verifyEndpointNetLogCapture({ ...capture, dirIno: otherIno })).toBe(false);
    expect(verifyEndpointNetLogCapture({ ...capture, dirDev: otherDev })).toBe(false);
  });

  it('目标被换成 symlink → 不通过', () => {
    if (process.platform === 'win32') return;
    const capture = prepareEndpointNetLogFile(logDir)!;
    const real = path.join(logDir, 'elsewhere.json');
    fs.writeFileSync(real, '{}', 'utf8');
    fs.symlinkSync(real, capture.file);
    expect(verifyEndpointNetLogCapture(capture)).toBe(false);
  });

  it('产物根本不存在 → 不通过', () => {
    const capture = prepareEndpointNetLogFile(logDir)!;
    expect(verifyEndpointNetLogCapture(capture)).toBe(false);
  });
});

describe('getter / IPC', () => {
  it('默认不是离线缓存启动', () => {
    expect(isUsingCachedClientEndpoints()).toBe(false);
  });

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
