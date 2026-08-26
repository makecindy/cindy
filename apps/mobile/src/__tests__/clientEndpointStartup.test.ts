/**
 * 远程端点清单启动解析(clientEndpointStartup)+ env live binding 回写单测。
 *
 * 关键覆盖:
 *  - 正式包只认 CDN 清单;字段缺失/空白不阻断,拉取失败或清单非法仍阻断;
 *  - 不使用包内 endpoint.json 做字段合并或整份回退;
 *  - applyResolvedClientEndpoints 重赋值后,跨模块 ESM live binding 立即可见。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ManifestFetchResult } from '@/config/clientEndpointStartup';

type FetchManifest = (timeoutMs: number) => Promise<ManifestFetchResult>;

async function freshModules() {
  vi.resetModules();
  const env = await import('@/config/env');
  const startup = await import('@/config/clientEndpointStartup');
  return { env, startup };
}

const FULL_MANIFEST_OBJECT = {
  schemaVersion: 1,
  // apiBaseUrl 已退役出 parser:留在 fixture 里覆盖"未知字段向前兼容忽略"。
  apiBaseUrl: 'https://api-next.example.com',
  authApiBaseUrl: 'https://auth-next.example.com',
  deviceLinkApiBaseUrl: 'https://relay-next.example.com',
  oauthBrokerApiBaseUrl: 'https://oauth-next.example.com',
  ossApiBaseUrl: 'https://oss-next.example.com',
  heartbeatUrl: 'https://heartbeat-next.example.com',
  telegramHookWsUrl: 'wss://telegram-hook-next.example.com',
  slackHookWsUrl: 'wss://hook-next.example.com',
  websiteUrl: 'https://www.next.example.com',
  modelAccessApiBaseUrl: 'https://model-access-next.example.com',
  voiceApiBaseUrl: 'https://voice-next.example.com',
  githubApiBaseUrl: 'https://github-api-next.example.com',
  skillhubApiBaseUrl: 'https://skillhub-next.example.com',
  cdnBaseUrl: 'https://cdn-next.example.com/app',
  mobileUpdateBaseUrl: 'https://mobile-update-next.example.com',
};
const FULL_MANIFEST = JSON.stringify(FULL_MANIFEST_OBJECT);

const okFetch = (text: string) => async () => ({ ok: true as const, text });
const failFetch = (detail: string) => async () => ({
  ok: false as const,
  detail,
});
/** 关掉自动重试预算,测"单次尝试"原语义(不然失败路径会白等真实 backoff)。 */
const NO_AUTO_RETRY = { autoRetryDelaysMs: [] as readonly number[] };

describe('runStartupEndpointResolve(CDN 解析)', () => {
  it('拉取成功:全量采用 CDN 清单,回写 env live binding,跨模块可见', async () => {
    const { env, startup } = await freshModules();
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay.example.invalid');

    const outcome = await startup.runStartupEndpointResolve({
      fetchManifest: okFetch(FULL_MANIFEST),
    });

    expect(outcome).toEqual({ ok: true, source: 'cdn' });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-next.example.com');
    expect(env.OAUTH_BROKER_API_BASE_URL).toBe(
      'https://oauth-next.example.com',
    );
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay-next.example.com');
    // 语音网关地址与清单解耦(xdGatewayBaseUrl 已退役):保持构建期 env 值不动。
    expect(env.MOBILE_VOICE_LITELLM_BASE_URL).toBe(
      'https://gateway.example.invalid',
    );
    // 非自建变体(IS_OTA_SELFHOST=false):mobileUpdateBaseUrl 不覆写,恒空串。
    expect(env.OTA_SERVER_BASE_URL).toBe('');
    expect(env.REVIEW_MODE).toBe(false);
  });

  it('清单自报区域与构建区域不一致时阻断，缺少 region 的老清单仍兼容', async () => {
    const { env, startup } = await freshModules();
    const mismatchedRegion =
      env.BUILD_AUTH_REGION === 'cn' ? 'global' : 'cn';
    await expect(
      startup.runStartupEndpointResolve({
        fetchManifest: okFetch(
          JSON.stringify({
            ...FULL_MANIFEST_OBJECT,
            region: mismatchedRegion,
          }),
        ),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: `region-mismatch:${env.BUILD_AUTH_REGION}:${mismatchedRegion}`,
    });

    await expect(
      startup.runStartupEndpointResolve({
        fetchManifest: okFetch(FULL_MANIFEST),
      }),
    ).resolves.toEqual({ ok: true, source: 'cdn' });
  });

  it('二进制版本优先读原生 0.1.2，不被 OTA manifest 的 0.1.0 覆盖', async () => {
    vi.resetModules();
    vi.doMock('expo-application', () => ({
      nativeApplicationVersion: '0.1.2',
    }));
    vi.doMock('expo-constants', () => ({
      default: { expoConfig: { version: '0.1.0' } },
    }));
    try {
      const env = await import('@/config/env');
      expect(env.APP_BINARY_VERSION).toBe('0.1.2');
    } finally {
      vi.doUnmock('expo-application');
      vi.doUnmock('expo-constants');
      vi.resetModules();
    }
  });

  it('清单 review 命中二进制版本号且非 TestFlight → REVIEW_MODE=true', async () => {
    vi.resetModules();
    vi.doMock('expo-constants', () => ({
      default: { expoConfig: { version: '9.9.9' } },
    }));
    try {
      const env = await import('@/config/env');
      const startup = await import('@/config/clientEndpointStartup');
      expect(env.APP_BINARY_VERSION).toBe('9.9.9');
      expect(env.REVIEW_MODE).toBe(false);

      let outcome = await startup.runStartupEndpointResolve({
        fetchManifest: okFetch(
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '9.9.8' }),
        ),
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(false);

      outcome = await startup.runStartupEndpointResolve({
        fetchManifest: okFetch(
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '9.9.9' }),
        ),
        resolveIsTestFlight: async () => false,
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(true);
      expect(env.IS_TESTFLIGHT_BUILD).toBe(false);

      outcome = await startup.runStartupEndpointResolve({
        fetchManifest: okFetch(
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '9.9.9' }),
        ),
        resolveIsTestFlight: async () => true,
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(false);
      expect(env.IS_TESTFLIGHT_BUILD).toBe(true);

      outcome = await startup.runStartupEndpointResolve({
        fetchManifest: okFetch(
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: '' }),
        ),
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.REVIEW_MODE).toBe(false);
    } finally {
      vi.doUnmock('expo-constants');
      vi.resetModules();
    }
  });

  it.each([
    [
      '缺字段',
      (() => {
        const manifest: Record<string, unknown> = { ...FULL_MANIFEST_OBJECT };
        delete manifest.heartbeatUrl;
        return JSON.stringify(manifest);
      })(),
    ],
    ['字段空串', JSON.stringify({ ...FULL_MANIFEST_OBJECT, heartbeatUrl: '' })],
  ] as const)('%s → 放行并按空串回写', async (_label, text) => {
    const { startup } = await freshModules();
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifest: okFetch(text),
      apply,
    });

    expect(outcome).toEqual({ ok: true, source: 'cdn' });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatUrl: '' }),
    );
  });

  it('缺失/空白字段经真实 apply 清空 mobile live binding', async () => {
    const { env, startup } = await freshModules();
    env.applyResolvedClientEndpoints({
      authApiBaseUrl: 'https://auth-old.example.com',
      deviceLinkApiBaseUrl: 'https://relay-old.example.com',
    });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-old.example.com');
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay-old.example.com');
    const manifest: Record<string, unknown> = { ...FULL_MANIFEST_OBJECT };
    delete manifest.authApiBaseUrl;
    manifest.deviceLinkApiBaseUrl = '   ';

    await expect(
      startup.runStartupEndpointResolve({
        fetchManifest: okFetch(JSON.stringify(manifest)),
      }),
    ).resolves.toEqual({ ok: true, source: 'cdn' });
    expect(env.AUTH_API_BASE_URL).toBe('');
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('');
  });

  it.each([
    [
      '字段非法 URL',
      JSON.stringify({ ...FULL_MANIFEST_OBJECT, heartbeatUrl: 'not-a-url' }),
      'invalid-field:heartbeatUrl',
    ],
    [
      'review 非 string',
      JSON.stringify({ ...FULL_MANIFEST_OBJECT, review: true }),
      'invalid-field:review',
    ],
    [
      'schema 不兼容',
      JSON.stringify({ ...FULL_MANIFEST_OBJECT, schemaVersion: 999 }),
      'unsupported-schema-version:999',
    ],
    ['非 JSON', 'not-json{', 'invalid-json'],
  ] as const)('%s → 直接阻断,不回写任何端点', async (_label, text, reason) => {
    const { env, startup } = await freshModules();
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifest: okFetch(text),
      apply,
    });

    expect(outcome).toEqual({ ok: false, reason });
    expect(apply).not.toHaveBeenCalled();
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay.example.invalid');
  });

  it('拉取失败 → 阻断且 reason 带错误码,不回写任何端点', async () => {
    const { env, startup } = await freshModules();
    const apply = vi.fn();
    const outcome = await startup.runStartupEndpointResolve({
      fetchManifest: failFetch('timeout-10000ms'),
      apply,
      ...NO_AUTO_RETRY,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'fetch-failed:timeout-10000ms',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(env.DEVICE_LINK_API_BASE_URL).toBe('https://relay.example.invalid');
  });

  it('fetch 抛错视同拉取失败并阻断(reason 带 name);下一次重试成功后才回写', async () => {
    const { env, startup } = await freshModules();
    const initialAuthApiBaseUrl = env.AUTH_API_BASE_URL;
    const fetchManifest = vi
      .fn<FetchManifest>()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST });

    await expect(
      startup.runStartupEndpointResolve({ fetchManifest, ...NO_AUTO_RETRY }),
    ).resolves.toEqual({
      ok: false,
      reason: 'fetch-failed:TypeError:Network request failed',
    });
    expect(env.AUTH_API_BASE_URL).toBe(initialAuthApiBaseUrl);

    await expect(
      startup.runStartupEndpointResolve({ fetchManifest, ...NO_AUTO_RETRY }),
    ).resolves.toEqual({
      ok: true,
      source: 'cdn',
    });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-next.example.com');
  });

  describe('返回失败前的自动重试(首装瞬时失败自愈)', () => {
    it('拉取失败后自动重试成功:闸门不进错误屏', async () => {
      const { env, startup } = await freshModules();
      const fetchManifest = vi
        .fn<FetchManifest>()
        .mockResolvedValueOnce({ ok: false, detail: 'timeout-10000ms' })
        .mockResolvedValueOnce({
          ok: false,
          detail: 'TypeError:Network request failed',
        })
        .mockResolvedValueOnce({ ok: true, text: FULL_MANIFEST });
      const sleep = vi
        .fn<(ms: number) => Promise<void>>()
        .mockResolvedValue(undefined);

      const outcome = await startup.runStartupEndpointResolve({
        fetchManifest,
        autoRetryDelaysMs: [10, 20],
        sleep,
      });

      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(fetchManifest).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
      expect(env.AUTH_API_BASE_URL).toBe('https://auth-next.example.com');
    });

    it('预算用尽才阻断,reason 是最后一次的错误码', async () => {
      const { startup } = await freshModules();
      const fetchManifest = vi
        .fn<FetchManifest>()
        .mockResolvedValueOnce({ ok: false, detail: 'AbortError:Aborted' })
        .mockResolvedValue({ ok: false, detail: 'timeout-10000ms' });

      const outcome = await startup.runStartupEndpointResolve({
        fetchManifest,
        autoRetryDelaysMs: [10, 20],
        sleep: async () => {},
      });

      expect(fetchManifest).toHaveBeenCalledTimes(3); // 首发 + 2 次自动重试
      expect(outcome).toEqual({
        ok: false,
        reason: 'fetch-failed:timeout-10000ms',
      });
    });

    it('清单非法(配置事故)不消耗重试预算', async () => {
      const { startup } = await freshModules();
      const fetchManifest = vi
        .fn<FetchManifest>()
        .mockResolvedValue({ ok: true, text: 'not-json{' });
      const sleep = vi
        .fn<(ms: number) => Promise<void>>()
        .mockResolvedValue(undefined);

      const outcome = await startup.runStartupEndpointResolve({
        fetchManifest,
        autoRetryDelaysMs: [10, 20],
        sleep,
      });

      expect(outcome).toEqual({ ok: false, reason: 'invalid-json' });
      expect(fetchManifest).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('missing-manifest-base-url(打包配置事故)不消耗重试预算', async () => {
      const { startup } = await freshModules();
      const fetchManifest = vi
        .fn<FetchManifest>()
        .mockResolvedValue({ ok: false, detail: 'missing-manifest-base-url' });
      const sleep = vi
        .fn<(ms: number) => Promise<void>>()
        .mockResolvedValue(undefined);

      const outcome = await startup.runStartupEndpointResolve({
        fetchManifest,
        autoRetryDelaysMs: [10, 20],
        sleep,
      });

      expect(outcome).toEqual({
        ok: false,
        reason: 'fetch-failed:missing-manifest-base-url',
      });
      expect(fetchManifest).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it.each([403, 404, 301])(
      'HTTP %d(永久性错误)不消耗重试预算',
      async (status) => {
        const { startup } = await freshModules();
        const fetchManifest = vi
          .fn<FetchManifest>()
          .mockResolvedValue({ ok: false, detail: `http-${status}` });
        const sleep = vi
          .fn<(ms: number) => Promise<void>>()
          .mockResolvedValue(undefined);

        const outcome = await startup.runStartupEndpointResolve({
          fetchManifest,
          autoRetryDelaysMs: [10, 20],
          sleep,
        });

        expect(outcome).toEqual({
          ok: false,
          reason: `fetch-failed:http-${status}`,
        });
        expect(fetchManifest).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      },
    );

    it('HTTP 502(瞬时服务端错误)仍消耗重试预算', async () => {
      const { startup } = await freshModules();
      const fetchManifest = vi
        .fn<FetchManifest>()
        .mockResolvedValue({ ok: false, detail: 'http-502' });
      const sleep = vi
        .fn<(ms: number) => Promise<void>>()
        .mockResolvedValue(undefined);

      const outcome = await startup.runStartupEndpointResolve({
        fetchManifest,
        autoRetryDelaysMs: [10, 20],
        sleep,
      });

      expect(outcome).toEqual({ ok: false, reason: 'fetch-failed:http-502' });
      expect(fetchManifest).toHaveBeenCalledTimes(3); // 首发 + 2 次自动重试
      expect(sleep).toHaveBeenCalledTimes(2);
    });
  });

  it('自建变体(IS_OTA_SELFHOST=1):mobileUpdateBaseUrl 只能在 CDN 清单校验通过后生效', async () => {
    process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST = '1';
    try {
      const { env, startup } = await freshModules();
      expect(env.OTA_SERVER_BASE_URL).toBe('');
      const outcome = await startup.runStartupEndpointResolve({
        fetchManifest: okFetch(FULL_MANIFEST),
      });
      expect(outcome).toEqual({ ok: true, source: 'cdn' });
      expect(env.OTA_SERVER_BASE_URL).toBe(
        'https://mobile-update-next.example.com',
      );

      const blankUpdateManifest = JSON.stringify({
        ...FULL_MANIFEST_OBJECT,
        mobileUpdateBaseUrl: '',
      });
      await expect(
        startup.runStartupEndpointResolve({
          fetchManifest: okFetch(blankUpdateManifest),
        }),
      ).resolves.toEqual({ ok: true, source: 'cdn' });
      expect(env.OTA_SERVER_BASE_URL).toBe('');
    } finally {
      delete process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST;
      vi.resetModules();
    }
  });
});

describe('isReviewModeActive(送审版本号匹配纯函数)', () => {
  it('严格相等(含 trim)且非 TestFlight 才命中;任一侧为空恒 false', async () => {
    const { env } = await freshModules();
    expect(env.isReviewModeActive('1.4.0', '1.4.0')).toBe(true);
    expect(env.isReviewModeActive(' 1.4.0 ', '1.4.0')).toBe(true);
    expect(env.isReviewModeActive('1.4.0', '1.4.0', true)).toBe(false);
    expect(env.isReviewModeActive('1.4.1', '1.4.0')).toBe(false);
    expect(env.isReviewModeActive(null, '1.4.0')).toBe(false);
    expect(env.isReviewModeActive(undefined, '1.4.0')).toBe(false);
    expect(env.isReviewModeActive('', '1.4.0')).toBe(false);
    // 拿不到二进制版本号(空串)时宁可不进审核模式。
    expect(env.isReviewModeActive('1.4.0', '')).toBe(false);
    expect(env.isReviewModeActive('', '')).toBe(false);
  });

  it('android 恒 false:清单 review 命中同版本号也不冻结安卓的更新检查', async () => {
    const { env } = await freshModules();
    // iOS 保持原语义(命中即进审核模式),android 在同样输入下豁免。
    expect(env.isReviewModeActive('0.1.0', '0.1.0', false, 'ios')).toBe(true);
    expect(env.isReviewModeActive('0.1.0', '0.1.0', false, 'android')).toBe(false);
    // TestFlight 豁免与平台豁免互不干扰。
    expect(env.isReviewModeActive('0.1.0', '0.1.0', true, 'android')).toBe(false);
    // 平台未知(内联缺失且 Constants.platform 无平台段)时不弱化 iOS 送审合规。
    expect(env.isReviewModeActive('0.1.0', '0.1.0', false, '')).toBe(true);
  });

  it('APP_PLATFORM 取 EXPO_OS 内联值;缺失时回落 Constants.platform 平台段', async () => {
    process.env.EXPO_OS = 'android';
    try {
      const { env } = await freshModules();
      expect(env.APP_PLATFORM).toBe('android');
      // 平台默认参数走 APP_PLATFORM,安卓 bundle 下审核模式恒关。
      expect(env.isReviewModeActive('0.1.0', '0.1.0')).toBe(false);
    } finally {
      delete process.env.EXPO_OS;
      vi.resetModules();
    }
  });

  it('EXPO_OS 内联缺失时回落 Constants.platform 平台段(安卓豁免不靠单一信号)', async () => {
    // 这条兜底是「安卓被审核模式误冻结热更」的最后一道防线:babel 内联一旦失效
    // (自定义 babel 配置等),没有它就会静默回归高代价故障,故单独断言。
    delete process.env.EXPO_OS;
    const platformCases = [
      { manifest: { android: { versionCode: 12 } }, expected: 'android' },
      { manifest: { ios: { buildNumber: '12' } }, expected: 'ios' },
      // 无平台段(web / 结构变化)→ 空串,走平台未知语义。
      { manifest: {}, expected: '' },
    ];
    for (const { manifest, expected } of platformCases) {
      vi.doMock('expo-constants', () => ({
        default: { expoConfig: null, platform: manifest },
      }));
      try {
        vi.resetModules();
        const env = await import('@/config/env');
        expect(env.APP_PLATFORM).toBe(expected);
        // 兜底判出 android 时同样恒豁免审核模式。
        expect(env.isReviewModeActive('0.1.0', '0.1.0')).toBe(expected !== 'android');
      } finally {
        vi.doUnmock('expo-constants');
        vi.resetModules();
      }
    }
  });

  it('APP_PLATFORM 只认 ios / android:其余内联值收敛为空串,不逸出取值域', async () => {
    // web / 未来新平台 / 被改写成意外值时都按「拿不到平台」处理(此处
    // Constants.platform 亦无平台段),而不是把原值透传给平台门控。
    for (const value of ['web', 'ANDROID_TV', 'unknown']) {
      process.env.EXPO_OS = value;
      try {
        const { env } = await freshModules();
        expect(env.APP_PLATFORM).toBe('');
      } finally {
        delete process.env.EXPO_OS;
        vi.resetModules();
      }
    }
  });
});

describe('applyResolvedClientEndpoints', () => {
  it('构建区域缓存跟随 token 端点局部覆写,realm reset 不退回旧清单', async () => {
    const { env, startup } = await freshModules();
    await expect(
      startup.runStartupEndpointResolve({
        fetchManifest: okFetch(
          JSON.stringify({ ...FULL_MANIFEST_OBJECT, region: 'cn' }),
        ),
      }),
    ).resolves.toEqual({ ok: true, source: 'cdn' });
    env.applyResolvedClientEndpoints({
      authApiBaseUrl: 'https://auth.override.example.com',
      deviceLinkApiBaseUrl: 'https://device.override.example.com',
      voiceApiBaseUrl: 'https://voice.override.example.com',
    });
    expect(
      env.getMobileEndpointForRealm(
        env.BUILD_AUTH_REGION,
        'authApiBaseUrl',
      ),
    ).toBe(env.AUTH_API_BASE_URL);
    expect(
      env.getMobileEndpointForRealm(
        env.BUILD_AUTH_REGION,
        'deviceLinkApiBaseUrl',
      ),
    ).toBe(env.DEVICE_LINK_API_BASE_URL);
    expect(
      env.getMobileEndpointForRealm(
        env.BUILD_AUTH_REGION,
        'voiceApiBaseUrl',
      ),
    ).toBe(env.VOICE_API_BASE_URL);
    env.activateMobileSessionRealm(env.BUILD_AUTH_REGION);
    env.resetMobileSessionRealm();
    expect(env.AUTH_API_BASE_URL).toBe('https://auth.override.example.com');
    expect(env.DEVICE_LINK_API_BASE_URL).toBe(
      'https://device.override.example.com',
    );
    expect(env.VOICE_API_BASE_URL).toBe('https://voice.override.example.com');
  });

  it('构建区域 auth 字段:undefined 不修改,空串明确清空', async () => {
    const { env } = await freshModules();
    env.applyResolvedClientEndpoints({
      authApiBaseUrl: 'https://auth-new.example.com',
    });
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-new.example.com');
    env.applyResolvedClientEndpoints({});
    expect(env.AUTH_API_BASE_URL).toBe('https://auth-new.example.com');
    env.applyResolvedClientEndpoints({ authApiBaseUrl: '' });
    expect(env.AUTH_API_BASE_URL).toBe('');
  });

  it('组织会话切换 token 消费端点,退出后恢复构建区域且不改变更新端点', async () => {
    const { env, startup } = await freshModules();
    await expect(
      startup.runStartupEndpointResolve({
        fetchManifest: okFetch(FULL_MANIFEST),
      }),
    ).resolves.toEqual({ ok: true, source: 'cdn' });

    const buildUpdateBaseUrl = env.OTA_SERVER_BASE_URL;
    const peerRegion = env.BUILD_AUTH_REGION === 'cn' ? 'global' : 'cn';
    const peerManifest = {
      ...FULL_MANIFEST_OBJECT,
      authApiBaseUrl: `https://auth.${peerRegion}.example.com`,
      oauthBrokerApiBaseUrl: `https://oauth.${peerRegion}.example.com`,
      deviceLinkApiBaseUrl: `https://device.${peerRegion}.example.com`,
      voiceApiBaseUrl: `https://voice.${peerRegion}.example.com`,
      mobileUpdateBaseUrl: `https://update.${peerRegion}.example.com`,
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(peerManifest),
    } as Response);
    try {
      await env.loadMobileEndpointsForRealm(peerRegion);
      env.activateMobileSessionRealm(peerRegion);

      expect(env.AUTH_API_BASE_URL).toBe(peerManifest.authApiBaseUrl);
      expect(env.OAUTH_BROKER_API_BASE_URL).toBe(
        peerManifest.oauthBrokerApiBaseUrl,
      );
      expect(env.DEVICE_LINK_API_BASE_URL).toBe(
        peerManifest.deviceLinkApiBaseUrl,
      );
      expect(env.VOICE_API_BASE_URL).toBe(peerManifest.voiceApiBaseUrl);
      expect(env.OTA_SERVER_BASE_URL).toBe(buildUpdateBaseUrl);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `${env.ENDPOINT_MANIFEST_PEER_BASE_URL}/endpoint.json?t=`,
        ),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      env.resetMobileSessionRealm();
      expect(env.AUTH_API_BASE_URL).toBe(FULL_MANIFEST_OBJECT.authApiBaseUrl);
      expect(env.OAUTH_BROKER_API_BASE_URL).toBe(
        FULL_MANIFEST_OBJECT.oauthBrokerApiBaseUrl,
      );
      expect(env.DEVICE_LINK_API_BASE_URL).toBe(
        FULL_MANIFEST_OBJECT.deviceLinkApiBaseUrl,
      );
      expect(env.VOICE_API_BASE_URL).toBe(FULL_MANIFEST_OBJECT.voiceApiBaseUrl);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('不依赖远端跨区字段，按构建期可信地址加载旧格式对端清单', async () => {
    const { env, startup } = await freshModules();
    const buildRegion = env.BUILD_AUTH_REGION;
    const peerRegion = buildRegion === 'cn' ? 'global' : 'cn';
    await expect(
      startup.runStartupEndpointResolve({
        fetchManifest: okFetch(FULL_MANIFEST),
      }),
    ).resolves.toEqual({ ok: true, source: 'cdn' });

    const realmConfig = env.getMobileEndpointRealmConfig();
    expect(realmConfig.crossRealmOrgLoginEnabled).toBe(true);
    expect(realmConfig.realmManifestBaseUrls[buildRegion]).toBe(
      env.ENDPOINT_MANIFEST_BASE_URL,
    );
    expect(realmConfig.realmManifestBaseUrls[peerRegion]).toBe(
      env.ENDPOINT_MANIFEST_PEER_BASE_URL,
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          ...FULL_MANIFEST_OBJECT,
          authApiBaseUrl: `https://auth.${peerRegion}.example.com`,
        }),
    } as Response);
    try {
      await expect(
        env.loadMobileEndpointsForRealm(peerRegion),
      ).resolves.toMatchObject({
        authApiBaseUrl: `https://auth.${peerRegion}.example.com`,
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `${env.ENDPOINT_MANIFEST_PEER_BASE_URL}/endpoint.json?t=`,
        ),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('对端清单自报 region 时必须与目标区域一致，拒绝后不污染缓存', async () => {
    const { env, startup } = await freshModules();
    const buildRegion = env.BUILD_AUTH_REGION;
    const peerRegion = buildRegion === 'cn' ? 'global' : 'cn';
    await expect(
      startup.runStartupEndpointResolve({
        fetchManifest: okFetch(FULL_MANIFEST),
      }),
    ).resolves.toEqual({ ok: true, source: 'cdn' });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            ...FULL_MANIFEST_OBJECT,
            region: buildRegion,
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            ...FULL_MANIFEST_OBJECT,
            authApiBaseUrl: `https://auth.${peerRegion}.example.com`,
          }),
      } as Response);
    try {
      await expect(
        env.loadMobileEndpointsForRealm(peerRegion),
      ).rejects.toThrow(`region-mismatch:${peerRegion}:${buildRegion}`);
      await expect(
        env.loadMobileEndpointsForRealm(peerRegion),
      ).resolves.toMatchObject({
        authApiBaseUrl: `https://auth.${peerRegion}.example.com`,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
