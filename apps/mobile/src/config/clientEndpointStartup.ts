/**
 * clientEndpointStartup —— 客户端端点清单(`<hotfix CDN base>/endpoint.json`)
 * 的 mobile 启动解析(useStartupEndpointGate 的执行体;依赖注入、可纯函数单测)。
 *
 * 语义:**CDN 清单是正式包唯一事实源**。启动时仍先拉取并解析 JSON,但 endpoint
 * 字段允许按 region 缺失或留空,不会因此阻断业务树。清单无法获取、JSON / schema
 * 不可解析或非空 URL 值非法时仍由启动闸门显示重试页。不读包内 `endpoint.json`、
 * 不做字段合并、不做整份回退，
 * 避免线上配置错误被静默掩盖或不同端点跑在不同版本。
 *
 * 共享逻辑(schema / 校验)在 @cindy/maker-shared/client-endpoints;本文件负责
 * mobile 侧 IO(全局 fetch + AbortController)与启动阻断;成功后经
 * env.applyResolvedClientEndpoints 回写 live binding。
 *
 * 唯一的柔性是**返回失败前**的网络层自动重试(AUTO_RETRY_DELAYS_MS):首次
 * 安装后的第一次启动网络栈最冷(DNS / 代理无缓存、系统仍在校验安装包),
 * 单次失败就把用户推到错误屏是把瞬时抖动当成故障。只对拉取失败生效,
 * 不对解析 / 校验失败生效;预算用尽仍失败照样阻断,严格语义不变。
 */

import {
  resolveClientEndpointsStrict,
  type ClientEndpointMap,
} from '@cindy/maker-shared/client-endpoints';

import { ENDPOINT_MANIFEST_BASE_URL, applyResolvedClientEndpoints } from './env';

const MANIFEST_RELATIVE_PATH = '/endpoint.json';
/** 单次请求的网络超时——超时即阻断启动,不是无限等待。 */
const ATTEMPT_TIMEOUT_MS = 10_000;
/**
 * 返回失败前的自动重试节奏(ms);长度 = 额外尝试次数。与 desktop
 * clientEndpointsService 同语义,节奏按 mobile 的 10s 单次超时略收紧。
 */
const AUTO_RETRY_DELAYS_MS: readonly number[] = [700, 2000];

/**
 * 一次取清单原文的结果。失败带 `detail`(错误码级别短标识):原实现 `catch {}`
 * 把错误整个吞掉、reason 恒为 `fetch-failed`,错误屏与用户反馈里都分不清
 * 超时 / DNS / HTTP 状态码,排查全靠猜。
 */
export type ManifestFetchResult =
  | { ok: true; text: string }
  | { ok: false; detail: string };

/** 归一为单行并截断,避免长栈把错误屏文案撑爆。 */
function normalizeDetail(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** RN fetch 失败 → 简短标识(AbortError / TypeError: Network request failed 等)。 */
function describeFetchFailure(err: unknown): string {
  if (err instanceof Error) {
    return normalizeDetail(err.message ? `${err.name}:${err.message}` : err.name);
  }
  return normalizeDetail(String(err));
}

/** 失败 detail → 闸门 reason(保持 maker-shared 的 `fetch-failed` 前缀语义)。 */
function fetchFailedReason(detail: string): string {
  const normalized = normalizeDetail(detail);
  return normalized ? `fetch-failed:${normalized}` : 'fetch-failed';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchManifestViaCdn(timeoutMs: number): Promise<ManifestFetchResult> {
  // 构建缺自举基址属打包配置事故:CDN 级不可用,交给启动闸门阻断。
  if (!ENDPOINT_MANIFEST_BASE_URL) return { ok: false, detail: 'missing-manifest-base-url' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(
      `${ENDPOINT_MANIFEST_BASE_URL}${MANIFEST_RELATIVE_PATH}?t=${Date.now()}`,
      { signal: controller.signal },
    );
    if (!response.ok) return { ok: false, detail: `http-${response.status}` };
    return { ok: true, text: await response.text() };
  } catch (err) {
    // abort 与网络错在 RN 下都落到这里:自己记的 timedOut 比 err.name 可靠。
    return { ok: false, detail: timedOut ? `timeout-${timeoutMs}ms` : describeFetchFailure(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** 测试注入点;生产走默认实现。 */
export interface StartupEndpointResolveDeps {
  fetchManifest?: (timeoutMs: number) => Promise<ManifestFetchResult>;
  /** iOS 在端点闸门放行前读取 StoreKit 分发环境；其它平台返回 false。 */
  resolveIsTestFlight?: () => Promise<boolean>;
  apply?: (resolved: ClientEndpointMap & {
    reviewVersion: string | null;
    isTestFlight: boolean;
  }) => void;
  timeoutMs?: number;
  /** 自动重试节奏,默认 AUTO_RETRY_DELAYS_MS;传 `[]` 关闭(单次尝试)。 */
  autoRetryDelaysMs?: readonly number[];
  /** 仅测试注入(默认 setTimeout);让重试节奏零等待可测。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 首发尝试 + 自动重试,返回最后一次结果。只有拉取失败消耗预算;
 * 拿到正文即刻返回(是否合法由调用方解析判定,失败不重试)。
 */
async function fetchManifestWithRetry(args: {
  fetchManifest: (timeoutMs: number) => Promise<ManifestFetchResult>;
  timeoutMs: number;
  retryDelays: readonly number[];
  sleep: (ms: number) => Promise<void>;
}): Promise<ManifestFetchResult> {
  for (let attempt = 0; ; attempt += 1) {
    let fetched: ManifestFetchResult;
    try {
      fetched = await args.fetchManifest(args.timeoutMs);
    } catch (err) {
      fetched = { ok: false, detail: describeFetchFailure(err) };
    }
    if (fetched.ok) return fetched;
    // 构建/打包配置事故(基址为空)重试不会改变结果,立即退出。
    if (fetched.detail === 'missing-manifest-base-url') return fetched;
    // HTTP 3xx/4xx 是永久性错误,重试同一 URL 不会自愈;仅 5xx 可能是瞬时故障。
    const httpStatus = /^http-(\d+)$/.exec(fetched.detail)?.[1];
    if (httpStatus && Number(httpStatus) < 500) return fetched;
    const delay = args.retryDelays[attempt];
    if (delay === undefined) return fetched; // 预算用尽 → 交调用方阻断
    await args.sleep(delay);
  }
}

export type StartupEndpointResolveOutcome =
  | {
      ok: true;
      /** 正式包的生效端点只能来自 CDN 清单。 */
      source: 'cdn';
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
    const fetchManifest = deps.fetchManifest ?? fetchManifestViaCdn;
    const apply = deps.apply ?? applyResolvedClientEndpoints;
    const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
    const retryDelays = deps.autoRetryDelaysMs ?? AUTO_RETRY_DELAYS_MS;
    const sleep = deps.sleep ?? defaultSleep;

    const fetched = await fetchManifestWithRetry({
      fetchManifest,
      timeoutMs,
      retryDelays,
      sleep,
    });
    if (!fetched.ok) return { ok: false, reason: fetchFailedReason(fetched.detail) };

    // 拿到正文:解析/校验不过 = 线上清单配置错,重试同一份内容没有意义,直接阻断。
    const result = resolveClientEndpointsStrict(fetched.text);
    if (!result.ok) return { ok: false, reason: result.reason };

    // 分发环境识别失败不能把 endpoint 闸门变成启动故障；降级为非 TestFlight，
    // 保留既有 review 行为。真实 iOS 路径由 useStartupEndpointGate 注入 StoreKit 实现。
    let isTestFlight = false;
    try {
      isTestFlight = await (deps.resolveIsTestFlight?.() ?? Promise.resolve(false));
    } catch {
      isTestFlight = false;
    }

    apply({ ...result.endpoints, reviewVersion: result.reviewVersion, isTestFlight });
    return { ok: true, source: 'cdn' };
  } catch {
    return { ok: false, reason: 'internal-error' };
  }
}
