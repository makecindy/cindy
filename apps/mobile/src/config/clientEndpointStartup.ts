/** Startup discovery uses the same regional cache/bundle policy as session recovery.
 * Primary configuration errors remain blocking; no fields are merged across snapshots.
 */

import {
  classifyEndpointManifestFailure,
  type ResilientEndpointResult,
  type ClientEndpointMap,
  type ClientEndpointRegion,
} from '@cindy/maker-shared/client-endpoints';

import {
  BUILD_AUTH_REGION,
  ENDPOINT_MANIFEST_BASE_URL,
  applyResolvedClientEndpoints,
} from './env';
import {
  fetchMobileEndpointManifest,
  resolveMobileEndpointManifest,
} from './endpointManifestLoader';

const AUTO_RETRY_DELAYS_MS: readonly number[] = [700, 2000];
export type ManifestFetchResult =
  { ok: true; text: string } | { ok: false; detail: string };
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 测试注入点;生产走默认实现。 */
export interface StartupEndpointResolveDeps {
  fetchManifest?: (timeoutMs: number) => Promise<ManifestFetchResult>;
  /** iOS 在端点闸门放行前读取 StoreKit 分发环境；其它平台返回 false。 */
  resolveIsTestFlight?: () => Promise<boolean>;
  apply?: (
    resolved: ClientEndpointMap & {
      reviewVersion: string | null;
      isTestFlight: boolean;
      region: 'cn' | 'global' | null;
    },
  ) => void;
  /** CindyDev 切换 Release 时传入第二个受信任清单基址。 */
  manifestBaseUrl?: string;
  /** 目标清单必须匹配的 auth 物理区域；默认仍为安装包构建区域。 */
  expectedRegion?: ClientEndpointRegion;
  /** 只切业务端点，保留 CindyDev 构建清单决定的 OTA / 审核元数据。 */
  preserveBuildReleaseMetadata?: boolean;
  timeoutMs?: number;
  /** 自动重试节奏,默认 AUTO_RETRY_DELAYS_MS;传 `[]` 关闭(单次尝试)。 */
  autoRetryDelaysMs?: readonly number[];
  /** 仅测试注入(默认 setTimeout);让重试节奏零等待可测。 */
  sleep?: (ms: number) => Promise<void>;
}

export type StartupEndpointResolveOutcome =
  | {
      ok: true;
      source: 'cdn' | 'mirror' | 'cache' | 'bundled';
    }
  | { ok: false; reason: string };

/**
 * 严格解析:成功 → 回写 env live binding;失败 → 返回 reason,由闸门渲染错误屏,
 * 用户点重试 = 再调一次本函数。本函数自身永不 reject。
 *
 * 一次调用 = 首发尝试 + 若干次自动重试(仅拉取失败消耗预算,见
 * AUTO_RETRY_DELAYS_MS);拿到正文后解析 / 校验不过是配置事故,不重试。
 */
export async function runStartupEndpointResolve(
  deps: StartupEndpointResolveDeps = {},
): Promise<StartupEndpointResolveOutcome> {
  try {
    const baseUrl = deps.manifestBaseUrl ?? ENDPOINT_MANIFEST_BASE_URL;
    const expectedRegion = deps.expectedRegion ?? BUILD_AUTH_REGION;
    const apply =
      deps.apply ??
      ((resolved) =>
        applyResolvedClientEndpoints(resolved, {
          preserveBuildReleaseMetadata:
            deps.preserveBuildReleaseMetadata === true,
        }));
    let outcome: ResilientEndpointResult;
    for (let attempt = 0; ; attempt += 1) {
      outcome = await resolveMobileEndpointManifest(expectedRegion, baseUrl, {
        timeoutMs: deps.timeoutMs,
        fetchText: (url, timeoutMs) =>
          deps.fetchManifest
            ? deps.fetchManifest(timeoutMs)
            : fetchMobileEndpointManifest(url, timeoutMs),
      });
      if (outcome.ok) break;
      const delay = (deps.autoRetryDelaysMs ?? AUTO_RETRY_DELAYS_MS)[attempt];
      if (
        classifyEndpointManifestFailure(outcome.reason) !== 'network' ||
        delay === undefined
      )
        return outcome;
      // Only custom sources with no usable snapshot reach this retry path.
      await (deps.sleep ?? defaultSleep)(delay);
    }
    const result = outcome.parsed;

    // 分发环境识别失败不能把 endpoint 闸门变成启动故障；降级为非 TestFlight，
    // 保留既有 review 行为。真实 iOS 路径由 useStartupEndpointGate 注入 StoreKit 实现。
    let isTestFlight = false;
    try {
      isTestFlight = await (deps.resolveIsTestFlight?.() ??
        Promise.resolve(false));
    } catch {
      isTestFlight = false;
    }

    apply({
      ...result.endpoints,
      reviewVersion: result.reviewVersion,
      isTestFlight,
      region: result.region,
    });
    return {
      ok: true,
      source: outcome.source === 'network' ? 'cdn' : outcome.source,
    };
  } catch {
    return { ok: false, reason: 'internal-error' };
  }
}
