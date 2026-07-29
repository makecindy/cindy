/**
 * clientEndpointsService.ts
 * ---------------------------------------------------------------------------
 * 客户端远程端点清单(`<hotfix CDN base>/endpoint.json`)的 desktop 宿主层。
 *
 * 语义是**清单即唯一事实源 + 阻断式**(2026-07 与 Lizi 定案,三次收紧):
 * app.ready 内、createWindow / 一切更新检查之前解析清单;endpoint 字段允许按
 * region 缺失或留空,不会阻断启动;拉不到、JSON / schema 无法解析或非空值非法
 * 时才弹系统错误框(重试 / 退出),用户不重试成功就不放行启动。
 * **没有缓存回退、没有超时后静默继续、没有逐字段烘焙回退**——生效的端点
 * (含更新链 CDN base)全部来自清单,非空值配置非法会在启动时立刻暴露。
 * 唯一的柔性是弹框**之前**的网络层自动重试(AUTO_RETRY_DELAYS_MS,只对
 * 拉取失败生效、不对解析/校验失败生效),用于自愈首启瞬时抖动;重试用尽
 * 仍失败照样阻断,所以严格语义不变。
 *
 * 清单来源按运行形态三选一(resolveEndpointSource,纯函数可单测):
 *  - packaged / dev + --endpoints-cdn:从当前构建区域的烘焙自举基址
 *    ENDPOINT_MANIFEST_BASE_URL 直连拉取；另一物理区域的基址也在构建期注入，
 *    只用于组织区域发现和已绑定会话恢复；
 *  - dev 默认:读仓内 `config/endpoint.json`(XDT_ENDPOINT_MANIFEST_FILE 可
 *    指定其它文件,restart:desktop:local 用它指到 config/endpoint.local.json),
 *    同一条阻断循环,文件缺失 / 非法同样弹框——配置错要炸出来,不静默猜测;
 *    仅本地文件路径放开 allowHttp(localhost 场景),CDN 路径校验零放松。
 *
 * 共享逻辑(schema / 非空 URL 校验 / 缺省字段归一)在 @cindy/maker-shared/client-endpoints;
 * 本文件负责 desktop 侧 IO 与 renderer 消费(sendSync IPC,首帧同步可用)。
 *
 * 依赖方向(2026-07 重构后):manifestService(更新链)经 getClientEndpoint
 * 读清单的 cdnBaseUrl——本文件**不得** import manifestService(会成环);
 * isDev 语义在此内联为 !app.isPackaged。
 */

import fs from 'node:fs';
import path from 'node:path';

import { app, dialog, ipcMain, net } from 'electron';

import {
  resolveClientEndpointsStrict,
  type ClientEndpointKey,
  type ClientEndpointMap,
  type ClientEndpointRegion,
  type ParseClientEndpointManifestResult,
  type RealmManifestBaseUrls,
} from '@cindy/maker-shared/client-endpoints';

import { createLogger } from './logger';
import {
  ENDPOINT_MANIFEST_BASE_URL,
  ENDPOINT_MANIFEST_PEER_BASE_URL,
} from '../shared/endpoints';

const log = createLogger('clientEndpoints');

const MANIFEST_FILE_NAME = 'endpoint.json';
const BUILD_VARIANT = import.meta.env.VITE_CINDY_AUTH_REGION;
/** 与 authManager 的构建区域判定保持一致；dev 使用 CN auth 身份。 */
const BUILD_AUTH_REGION: ClientEndpointRegion =
  BUILD_VARIANT === 'global' ? 'global' : 'cn';
const DEFAULT_REALM_MANIFEST_BASE_URLS: RealmManifestBaseUrls =
  BUILD_AUTH_REGION === 'global'
    ? {
        cn: ENDPOINT_MANIFEST_PEER_BASE_URL,
        global: ENDPOINT_MANIFEST_BASE_URL,
      }
    : {
        cn: ENDPOINT_MANIFEST_BASE_URL,
        global: ENDPOINT_MANIFEST_PEER_BASE_URL,
      };
/** 单次请求的网络超时——只用于触发错误框,不是静默降级。 */
const ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * 弹阻断框**之前**的自动重试节奏(ms);长度 = 额外尝试次数,总尝试 = 1 + 长度。
 *
 * 背景(2026-07,mac 首次安装启动的现场反馈):本函数是 app.ready 的第一枪,而
 * "首次安装后的第一次启动"恰好是网络栈最冷的时刻——userData / Chromium profile
 * 与 network context 尚未建立、Gatekeeper 公证校验与 XProtect 还在扫整个 bundle、
 * 系统代理(macOS SystemConfiguration / PAC)与 DNS 全无缓存。原实现单次失败即
 * 弹阻断框,用户重启一次或点一下「重试」就正常 = 典型瞬时失败,却被呈现成
 * "无法获取服务器配置"。
 *
 * 这里补的只是"瞬时抖动自愈",不是静默降级:预算用尽仍失败照样弹框阻断,
 * 依然没有缓存回退、没有烘焙兜底。**只有网络层失败(fetch 未拿到正文)消耗
 * 预算**;JSON / schema / 非法值这类配置事故重试同一份内容没有意义,立刻弹框。
 *
 * 时长权衡:真断网时 DNS 立即失败,约 3.2s 就会弹框;最坏情况(三次都卡到
 * 15s 超时)约 48s 才弹框——此时网络确实不通,慢比误报好。
 */
const AUTO_RETRY_DELAYS_MS: readonly number[] = [800, 2400];

export const CLIENT_ENDPOINTS_SYNC_CHANNEL = 'client-endpoints:get-sync';

// ── 清单来源解析(纯函数,规则 14:内存 harness 可测) ─────────────────────

export type EndpointSource = { kind: 'cdn' } | { kind: 'file'; filePath: string };

export interface ResolveEndpointSourceInput {
  isPackaged: boolean;
  env: {
    /** '1' = dev 也走完整 CDN 拉取(index.ts 已把 --endpoints-cdn 收敛到该 env)。 */
    XDT_ENDPOINTS_CDN?: string;
    /** dev 本地清单文件覆盖(restart:desktop:local 指到 endpoint.local.json)。 */
    XDT_ENDPOINT_MANIFEST_FILE?: string;
  };
  /** 仓库根(dev 下 app.getAppPath() = apps/desktop,向上两级)。 */
  repoRoot: string;
}

/**
 * 决定清单从哪来:packaged 恒 CDN;dev 默认读仓内 config/endpoint.json,
 * XDT_ENDPOINT_MANIFEST_FILE 覆盖文件路径(相对路径以仓根为基准),
 * XDT_ENDPOINTS_CDN='1' 切回完整 CDN 链路。
 */
export function resolveEndpointSource(input: ResolveEndpointSourceInput): EndpointSource {
  if (input.isPackaged) return { kind: 'cdn' };
  if (input.env.XDT_ENDPOINTS_CDN === '1') return { kind: 'cdn' };
  const override = input.env.XDT_ENDPOINT_MANIFEST_FILE?.trim();
  const filePath = override
    ? path.resolve(input.repoRoot, override)
    : path.join(input.repoRoot, 'config', MANIFEST_FILE_NAME);
  return { kind: 'file', filePath };
}

// ── IO:CDN 拉取 / 本地文件读取 ─────────────────────────────────────────────

/**
 * 一次清单取原文的结果。失败携带 `detail`(错误码级别的短标识)——原实现把
 * error 对象整个丢掉、统一折叠成 `fetch-failed`,现场只能看到一句
 * "fetch-failed",日志里也无从区分 DNS / 代理 / TLS / 超时,排查全靠猜。
 */
export type ManifestFetchResult = { ok: true; text: string } | { ok: false; detail: string };

/** 归一为单行并截断:避免多行栈把弹框 detail 与日志行撑爆。 */
function normalizeDetail(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * 错误细节 → 简短错误码。Electron net 的 error.message 形如
 * `net::ERR_NAME_NOT_RESOLVED`,优先抽 `ERR_*` 码;抽不出时退回消息原文。
 */
function describeFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = /\b(ERR_[A-Z0-9_]+)\b/.exec(message)?.[1];
  return normalizeDetail(code ?? message);
}

/** 失败 detail → 阻断循环用的 reason(保持 maker-shared 的 `fetch-failed` 前缀语义)。 */
function fetchFailedReason(detail: string): string {
  const normalized = normalizeDetail(detail);
  return normalized ? `fetch-failed:${normalized}` : 'fetch-failed';
}

/** net.request 拉清单原文;任何失败(非 200 / 超时 / 异常)带错误码返回。 */
function fetchTextViaNet(url: string, timeoutMs: number): Promise<ManifestFetchResult> {
  return new Promise((resolve) => {
    try {
      const request = net.request(url);
      let body = '';
      let settled = false;
      const finish = (
        value: ManifestFetchResult,
        timeoutToClear?: ReturnType<typeof setTimeout>,
      ) => {
        if (settled) return;
        settled = true;
        if (timeoutToClear !== undefined) clearTimeout(timeoutToClear);
        if (!value.ok) log.debug('fetch failed (%s) for %s', value.detail, url);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        request.abort();
        finish({ ok: false, detail: `timeout-${timeoutMs}ms` });
      }, timeoutMs);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          response.on('data', () => {});
          finish({ ok: false, detail: `http-${response.statusCode}` }, timeout);
          return;
        }
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => finish({ ok: true, text: body }, timeout));
        response.on('error', (err) =>
          finish({ ok: false, detail: describeFetchError(err) }, timeout),
        );
      });
      request.on('error', (err) =>
        finish({ ok: false, detail: describeFetchError(err) }, timeout),
      );
      request.end();
    } catch (err) {
      resolve({ ok: false, detail: describeFetchError(err) });
    }
  });
}

function fetchManifestViaCdn(timeoutMs: number): Promise<ManifestFetchResult> {
  if (!ENDPOINT_MANIFEST_BASE_URL) {
    // 烘焙基址缺失属打包/构建配置事故,同样走阻断暴露(→ 弹框)。
    log.error('ENDPOINT_MANIFEST_BASE_URL is empty (build misconfiguration)');
    return Promise.resolve({ ok: false, detail: 'missing-manifest-base-url' });
  }
  // cache-bust:防 Chromium / CDN 复用陈旧清单。
  return fetchTextViaNet(
    `${ENDPOINT_MANIFEST_BASE_URL}/${MANIFEST_FILE_NAME}?t=${Date.now()}`,
    timeoutMs,
  );
}

/** dev 本地清单文件读取;缺失 / 读失败带 errno 返回(→ 同一条阻断弹框链路)。 */
function readManifestFromFile(filePath: string): ManifestFetchResult {
  try {
    return { ok: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    log.warn('failed to read local endpoint manifest %s: %s', filePath, String(err));
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return { ok: false, detail: code ?? describeFetchError(err) };
  }
}

// ── 阻断式解析循环 ──────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 阻断循环的依赖注入面(规则 14:测试用内存 harness 驱动,不起 Electron)。 */
export interface BlockingResolveDeps {
  fetchManifest(timeoutMs: number): Promise<ManifestFetchResult>;
  /** 拉取/校验失败时问用户;生产实现是系统模态错误框。 */
  promptRetry(reason: string): 'retry' | 'exit';
  exitApp(): void;
  timeoutMs?: number;
  /** 仅 dev 本地文件路径为 true(localhost http);CDN 路径一律不传。 */
  allowHttp?: boolean;
  /**
   * 清单带 region 元数据时必须与构建区域一致；缺少元数据的旧清单仍保持兼容。
   */
  expectedRegionWhenPresent?: ClientEndpointRegion;
  /**
   * 弹框前的自动重试节奏,默认 AUTO_RETRY_DELAYS_MS。file 模式传 `[]` 关闭:
   * 本地文件读不到 / 内容非法都是配置事故,重读同一路径没有意义,只会白等。
   */
  autoRetryDelaysMs?: readonly number[];
  /** 仅测试注入(默认 setTimeout);让重试节奏在内存 harness 里零等待可测。 */
  sleep?(ms: number): Promise<void>;
  /** 启动宿主保存清单元数据；纯端点调用方无需提供。 */
  onResolved?(manifest: Extract<ParseClientEndpointManifestResult, { ok: true }>): void;
}

/**
 * 阻断式解析循环:成功返回完整端点 map;用户选择退出返回 null(调用方不再继续启动)。
 *
 * 每一轮 = 一次首发尝试 + 若干次自动重试(仅网络层失败消耗预算,见
 * AUTO_RETRY_DELAYS_MS);一轮全败才 promptRetry,用户选 'retry' 则重新开一轮
 * (同样带完整自动重试预算)。没有任何静默降级路径。
 */
export async function resolveClientEndpointsBlocking(
  deps: BlockingResolveDeps,
): Promise<ClientEndpointMap | null> {
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const options = deps.allowHttp ? { allowHttp: true } : undefined;
  const retryDelays = deps.autoRetryDelaysMs ?? AUTO_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? defaultSleep;

  for (;;) {
    let reason = 'fetch-failed';
    for (let attempt = 0; ; attempt += 1) {
      let fetched: ManifestFetchResult;
      try {
        fetched = await deps.fetchManifest(timeoutMs);
      } catch (err) {
        fetched = { ok: false, detail: describeFetchError(err) };
      }

      if (fetched.ok) {
        const parsed = resolveClientEndpointsStrict(fetched.text, options);
        if (parsed.ok) {
          if (
            deps.expectedRegionWhenPresent &&
            parsed.region !== null &&
            parsed.region !== deps.expectedRegionWhenPresent
          ) {
            reason = `region-mismatch:${deps.expectedRegionWhenPresent}:${parsed.region}`;
            break;
          }
          deps.onResolved?.(parsed);
          return parsed.endpoints;
        }
        // 拿到了正文但解析/校验不过 = 配置事故:重试同一份内容没有意义,直接弹框。
        reason = parsed.reason;
        break;
      }

      reason = fetchFailedReason(fetched.detail);
      // 构建/打包配置事故(基址为空)重试不会改变结果,立即跳出。
      if (fetched.detail === 'missing-manifest-base-url') break;
      // HTTP 3xx/4xx 是永久性错误(路径/权限/配置),重试同一 URL 不会自愈;仅 5xx 可能是瞬时故障。
      const httpStatus = /^http-(\d+)$/.exec(fetched.detail)?.[1];
      if (httpStatus && Number(httpStatus) < 500) break;
      const delay = retryDelays[attempt];
      if (delay === undefined) break; // 预算用尽 → 阻断弹框
      log.warn(
        'manifest fetch failed (%s); auto-retry %d/%d in %dms',
        reason,
        attempt + 1,
        retryDelays.length,
        delay,
      );
      await sleep(delay);
    }

    log.warn(`client endpoints manifest unavailable (${reason}), prompting user`);
    if (deps.promptRetry(reason) === 'exit') {
      deps.exitApp();
      return null;
    }
  }
}

function promptRetryDialog(reason: string, sourceLabel: string): 'retry' | 'exit' {
  // createWindow 之前无父窗口,showMessageBoxSync 直接系统模态。
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Cindy',
    message: '无法获取服务器配置',
    detail:
      `启动所需的服务器端点清单获取失败(${reason})。\n` +
      `来源 source: ${sourceLabel}\n` +
      '请检查网络连接后重试;无法联网时应用不能继续启动。\n\n' +
      `Failed to load the server endpoint manifest (${reason}). ` +
      'Please check your network connection and retry.',
    buttons: ['重试 Retry', '退出 Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return choice === 0 ? 'retry' : 'exit';
}

// ── 模块状态与启动入口 ──────────────────────────────────────────────────────

let resolvedEndpoints: ClientEndpointMap | null = null;
let resolvedRegion: ClientEndpointRegion | null = null;
let crossRealmOrgLoginEnabled = BUILD_VARIANT !== 'dev';
let realmManifestBaseUrls: RealmManifestBaseUrls = DEFAULT_REALM_MANIFEST_BASE_URLS;
let activeSessionRealm: ClientEndpointRegion | null = null;
const realmEndpointCache = new Map<ClientEndpointRegion, ClientEndpointMap>();

const BUILD_SCOPED_ENDPOINT_KEYS = new Set<ClientEndpointKey>([
  'websiteUrl',
  'cdnBaseUrl',
  'mobileUpdateBaseUrl',
]);

/**
 * 启动第一步(先于一切更新检查):阻断式解析清单(packaged=CDN;dev=本地文件,
 * --endpoints-cdn 时同 packaged)。返回 true = 可以继续启动;false = 用户在
 * 错误框选择退出(app.exit 已调用,调用方必须立即 return,不再继续启动流程)。
 */
export async function initClientEndpoints(): Promise<boolean> {
  const source = resolveEndpointSource({
    isPackaged: app.isPackaged,
    env: {
      XDT_ENDPOINTS_CDN: process.env.XDT_ENDPOINTS_CDN,
      XDT_ENDPOINT_MANIFEST_FILE: process.env.XDT_ENDPOINT_MANIFEST_FILE,
    },
    // dev 下 app.getAppPath() = apps/desktop;packaged 不走 file 分支,该值无消费。
    repoRoot: path.resolve(app.getAppPath(), '..', '..'),
  });
  const sourceLabel =
    source.kind === 'cdn' ? `${ENDPOINT_MANIFEST_BASE_URL}/${MANIFEST_FILE_NAME}` : source.filePath;
  // The resolver reports the parsed manifest through a callback. Keep it in a
  // box so TypeScript does not incorrectly conclude that the callback-owned
  // assignment is unreachable at the reads below.
  const resolvedManifestBox: {
    value: Extract<ParseClientEndpointManifestResult, { ok: true }> | null;
  } = { value: null };
  const endpoints = await resolveClientEndpointsBlocking({
    fetchManifest:
      source.kind === 'cdn'
        ? fetchManifestViaCdn
        : () => Promise.resolve(readManifestFromFile(source.filePath)),
    promptRetry: (reason) => promptRetryDialog(reason, sourceLabel),
    exitApp: () => app.exit(1),
    allowHttp: source.kind === 'file',
    expectedRegionWhenPresent: BUILD_AUTH_REGION,
    // dev 本地文件:读不到就是路径/内容配置错,不自动重试(见 BlockingResolveDeps)。
    autoRetryDelaysMs: source.kind === 'cdn' ? undefined : [],
    onResolved: (manifest) => {
      resolvedManifestBox.value = manifest;
    },
  });
  if (endpoints === null) return false; // 用户选择退出,app.exit 已调用
  const resolvedManifest = resolvedManifestBox.value;
  resolvedEndpoints = endpoints;
  resolvedRegion = resolvedManifest?.region ?? null;
  // 老清单没有 region 元数据，但它一定来自构建区域的自举地址。只把这份端点
  // 缓存在构建区域，不能同时塞进两区，否则升级后留下的跨区 token 会被误发。
  activeSessionRealm = resolvedRegion ?? BUILD_AUTH_REGION;
  realmEndpointCache.clear();
  realmEndpointCache.set(activeSessionRealm, endpoints);
  log.info(
    'resolved from %s (%s): auth=%s cdn=%s',
    source.kind === 'cdn' ? 'remote manifest' : 'local manifest file',
    sourceLabel,
    endpoints.authApiBaseUrl,
    endpoints.cdnBaseUrl,
  );
  return true;
}

/**
 * 运行期端点读取入口(main 进程)。init 成功前调用 = 启动时序 bug,直接抛错
 * 炸出来(没有任何烘焙兜底可回落;--smoke-test 旁路只碰 localDb,不消费端点)。
 */
export function getClientEndpoint(key: ClientEndpointKey): string {
  if (resolvedEndpoints === null) {
    throw new Error(
      `client endpoints not initialized (getClientEndpoint('${key}') called before initClientEndpoints)`,
    );
  }
  if (BUILD_SCOPED_ENDPOINT_KEYS.has(key) || activeSessionRealm === null) {
    return resolvedEndpoints[key];
  }
  const sessionEndpoints = realmEndpointCache.get(activeSessionRealm);
  if (!sessionEndpoints) {
    throw new Error(`client endpoints for active realm '${activeSessionRealm}' not loaded`);
  }
  return sessionEndpoints[key];
}

/** 安装包身份/更新链始终读取启动时清单，不随组织会话区域切换。 */
export function getBuildClientEndpoint(key: ClientEndpointKey): string {
  if (resolvedEndpoints === null) {
    throw new Error('client endpoints not initialized');
  }
  return resolvedEndpoints[key];
}

export function getClientEndpointRealmConfig(): {
  buildRegion: ClientEndpointRegion;
  crossRealmOrgLoginEnabled: boolean;
  realmManifestBaseUrls: RealmManifestBaseUrls;
} {
  if (resolvedEndpoints === null) {
    throw new Error('client endpoints not initialized');
  }
  return {
    buildRegion: BUILD_AUTH_REGION,
    crossRealmOrgLoginEnabled,
    realmManifestBaseUrls,
  };
}

/**
 * 从构建期受信任地址加载指定区域清单。区域身份由地址表的 key 决定；清单不必
 * 重复自报 region，但一旦携带就必须与目标区域一致。失败不会修改当前会话端点，
 * 也不会退回构建区域发送跨区 token。
 */
export async function loadClientEndpointsForRealm(
  region: ClientEndpointRegion,
): Promise<ClientEndpointMap> {
  const cached = realmEndpointCache.get(region);
  if (cached) return cached;
  const baseUrl = realmManifestBaseUrls[region];
  if (!baseUrl) {
    throw new Error('realm-manifest-url-unavailable');
  }
  const fetched = await fetchTextViaNet(
    `${baseUrl}/${MANIFEST_FILE_NAME}?t=${Date.now()}`,
    ATTEMPT_TIMEOUT_MS,
  );
  if (!fetched.ok) {
    throw new Error(fetchFailedReason(fetched.detail));
  }
  const parsed = resolveClientEndpointsStrict(fetched.text);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  if (parsed.region !== null && parsed.region !== region) {
    throw new Error(`region-mismatch:${region}:${parsed.region}`);
  }
  realmEndpointCache.set(region, parsed.endpoints);
  return parsed.endpoints;
}

export function getClientEndpointForRealm(
  region: ClientEndpointRegion,
  key: ClientEndpointKey,
): string {
  if (BUILD_SCOPED_ENDPOINT_KEYS.has(key)) return getBuildClientEndpoint(key);
  const endpoints = realmEndpointCache.get(region);
  if (!endpoints) {
    throw new Error(`client endpoints for realm '${region}' not loaded`);
  }
  return endpoints[key];
}

export function activateClientEndpointRealm(region: ClientEndpointRegion): void {
  if (!realmEndpointCache.has(region)) {
    throw new Error(`client endpoints for realm '${region}' not loaded`);
  }
  activeSessionRealm = region;
}

export function resetClientEndpointRealm(): void {
  activeSessionRealm = resolvedRegion ?? BUILD_AUTH_REGION;
}

export function getResolvedClientEndpoints(): ClientEndpointMap {
  if (resolvedEndpoints === null) {
    throw new Error('client endpoints not initialized');
  }
  return { ...resolvedEndpoints };
}

/** renderer 首帧同步读取(preload 模块级 sendSync);必须在 createWindow() 前注册。 */
export function registerClientEndpointsIpc(): void {
  ipcMain.on(CLIENT_ENDPOINTS_SYNC_CHANNEL, (event) => {
    event.returnValue = getResolvedClientEndpoints();
  });
}

export interface ResetClientEndpointsForTestOptions {
  /** 指定后模拟一份真实带 region 元数据的构建清单。 */
  buildRegion?: ClientEndpointRegion;
  /** 注入其它区域清单，供运行期 realm 切换测试使用。 */
  realmEndpoints?: Partial<Record<ClientEndpointRegion, ClientEndpointMap>>;
  crossRealmOrgLoginEnabled?: boolean;
  realmManifestBaseUrls?: RealmManifestBaseUrls | null;
}

/** 仅测试:重置/注入模块状态。 */
export function resetClientEndpointsForTest(
  resolved?: ClientEndpointMap,
  options?: ResetClientEndpointsForTestOptions,
): void {
  resolvedEndpoints = resolved ?? null;
  resolvedRegion = resolved ? (options?.buildRegion ?? null) : null;
  crossRealmOrgLoginEnabled = options?.crossRealmOrgLoginEnabled ?? BUILD_VARIANT !== 'dev';
  realmManifestBaseUrls =
    options?.realmManifestBaseUrls ?? DEFAULT_REALM_MANIFEST_BASE_URLS;
  activeSessionRealm = resolvedRegion;
  realmEndpointCache.clear();
  // 既有 desktop 单测只注入一份逻辑端点，不关心物理区域；让两种构建区域都能
  // 使用同一 fixture，避免测试辅助接口被生产清单元数据耦合。
  if (resolved) {
    if (resolvedRegion) {
      realmEndpointCache.set(resolvedRegion, resolved);
    } else {
      realmEndpointCache.set('cn', resolved);
      realmEndpointCache.set('global', resolved);
    }
  }
  for (const region of ['cn', 'global'] as const) {
    const endpoints = options?.realmEndpoints?.[region];
    if (endpoints) realmEndpointCache.set(region, endpoints);
  }
}
