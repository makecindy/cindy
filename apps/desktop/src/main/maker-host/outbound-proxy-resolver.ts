/**
 * Desktop 出站代理解析器 ——
 *
 * 本地 loopback proxy(anthropic-compat-proxy / codex proxy)转发上游用的是 Node http
 * 栈,不读系统代理也不读代理环境变量;用户代理软件跑「系统代理」模式(非 TUN)时,
 * 浏览器 / Codex CLI 正常而 Cindy 上游连接裸直连失败(502 upstream unreachable:
 * AggregateError)。本模块给两个 proxy host 注入统一的解析器,分两层:
 *
 *   1. 代理环境变量(HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY):终端 dev
 *      启动、用户显式配置的场景。只要设置了任一代理 env,就以 env 的判定为准
 *      (包括 NO_PROXY 命中 = 直连,不再落到系统代理 —— 用户显式豁免的域不该被
 *      系统代理接管)。
 *   2. 系统代理(Electron session.resolveProxy):GUI 启动拿不到 shell env 的主场景。
 *      Chromium 按系统设置 / PAC 逐 URL 解析,结果做短 TTL 缓存;支持 PROXY(明文
 *      HTTP 代理)与 SOCKS5 条目,HTTPS(TLS-to-proxy)/ SOCKS(=v4)跳过并继续找
 *      下一个候选,全部不支持则直连(fail-open)。
 *
 * 解析结果变化时记一条 info(每个 origin 只在值变化时记),排查网络问题时 grep
 * "outbound proxy" 即可看到当前生效路径。
 */

import { app, session } from 'electron';

import {
  createEnvOutboundProxyResolver,
  hasProxyEnvConfig,
  redactProxyUrlForLog,
  type OutboundProxyResolver,
} from '@cindy/anthropic-compat-proxy';

import { createMakerLogger } from './logger-adapter.js';

const log = createMakerLogger('outbound-proxy');

// 系统代理解析结果的 TTL:用户切换代理软件开关后最迟 30s 生效;Chromium 侧
// resolveProxy 本身有缓存,这层主要省 per-request 的 Promise/IPC 往返。
const SYSTEM_PROXY_CACHE_TTL_MS = 30 * 1000;

/**
 * 解析 Chromium resolveProxy 返回的 PAC 结果串(例 "PROXY 127.0.0.1:7890; SOCKS5
 * 127.0.0.1:7891; DIRECT")→ 一个代理地址(http:// 或 socks5://);没有可用条目
 * → null(直连)。导出仅供单测。
 *
 * **已知限制(本模块一直如此)**:resolver 契约是「一次解析给一个结果」,不表达 PAC
 * 的回退链 —— 选中的条目连不上就是失败,不会自动退到下一个候选或 DIRECT。真要支持
 * 回退,得把 OutboundProxyResolver 的返回值改成候选列表,并在 anthropic-compat-proxy
 * 的转发层按「建连失败」而非「上游报错」的判据逐个重试;那是独立于本模块的改造。
 *
 * 在这个限制下,同一份 PAC 结果里 **PROXY 优先于 SOCKS5**:
 *   - `SOCKS5 A; PROXY B; DIRECT` → 选 B。与支持 SOCKS5 之前逐字节一致 —— 那时
 *     SOCKS5 条目被跳过,B 照样可用;若改成选 A,A 一挂就成了 502,凭空多出一种
 *     原来不存在的失败模式。
 *   - `SOCKS5 A; DIRECT` → 选 A。这正是「代理软件只开 SOCKS 出口」的形态,也是
 *     支持 SOCKS5 的意义所在(此时直连会因本机解不出上游域名而 ENOTFOUND)。
 * DIRECT 之后的条目不再考虑:PAC 里 DIRECT 意味着「到此为止,直连即可」。
 * HTTPS(TLS-to-proxy)与裸 SOCKS(Chromium 里就是 v4)不支持,跳过。
 */
export function parseChromiumProxyResult(result: string): string | null {
  let socks5Fallback: string | null = null;
  for (const rawEntry of result.split(';')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const spaceIdx = entry.indexOf(' ');
    const kind = (spaceIdx === -1 ? entry : entry.slice(0, spaceIdx)).toUpperCase();
    if (kind === 'DIRECT') break;
    const hostPort = spaceIdx === -1 ? '' : entry.slice(spaceIdx + 1).trim();
    if (!hostPort) continue;
    if (kind === 'PROXY') return `http://${hostPort}`;
    // 先记下第一个 SOCKS5;扫完(或遇到 DIRECT)确认没有 PROXY 候选才用它。
    if (kind === 'SOCKS5') socks5Fallback ??= `socks5://${hostPort}`;
  }
  return socks5Fallback;
}

interface CachedResolution {
  value: string | null;
  expiresAt: number;
}

const systemProxyCache = new Map<string, CachedResolution>();
// 每个 origin 上次记录过日志的生效值;仅在变化时记 info,避免 per-request 刷日志。
const lastLoggedByOrigin = new Map<string, string>();

function logIfChanged(upstreamUrl: string, source: 'env' | 'system', value: string | null): void {
  // env 值可能是 http://user:pass@host 形态,持久化日志只允许脱敏形态(scheme://host:port)。
  const rendered = value === null ? 'direct' : redactProxyUrlForLog(value);
  if (lastLoggedByOrigin.get(upstreamUrl) === `${source}:${rendered}`) return;
  lastLoggedByOrigin.set(upstreamUrl, `${source}:${rendered}`);
  log.info('outbound proxy resolved', { upstream: upstreamUrl, source, proxy: rendered });
}

async function resolveViaSystemProxy(upstreamUrl: string): Promise<string | null> {
  const cached = systemProxyCache.get(upstreamUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  // app 未 ready 时 session 不可用;此时按直连处理(splash 极早期,正常请求不会赶在这)。
  if (!app.isReady()) return null;
  const ses = session.defaultSession;
  if (!ses || typeof ses.resolveProxy !== 'function') return null;
  let value: string | null = null;
  try {
    value = parseChromiumProxyResult(await ses.resolveProxy(upstreamUrl));
  } catch (err) {
    log.warn('system proxy resolution failed — using direct connection', {
      upstream: upstreamUrl,
      err: err instanceof Error ? err.message : String(err),
    });
    value = null;
  }
  systemProxyCache.set(upstreamUrl, { value, expiresAt: Date.now() + SYSTEM_PROXY_CACHE_TTL_MS });
  return value;
}

// 惰性初始化:单测可能对 @cindy/anthropic-compat-proxy 做部分 mock(如 codexProxyHost
// 测试只 mock 了 createAnthropicCompatProxy),模块加载期不能调用包函数。
let _envResolver: ((upstreamUrl: string) => string | null) | null = null;
function envResolver(upstreamUrl: string): string | null {
  _envResolver ??= createEnvOutboundProxyResolver();
  return _envResolver(upstreamUrl);
}

/**
 * 两个 proxy host 共用的出站代理解析器(单例,系统代理缓存共享)。
 * per-request 由 anthropic-compat-proxy 以最终上游 origin 调用;loopback 上游
 * 在包侧已被过滤,不会到这里。
 */
export const resolveDesktopOutboundProxy: OutboundProxyResolver = async (upstreamUrl) => {
  if (hasProxyEnvConfig()) {
    const fromEnv = envResolver(upstreamUrl);
    logIfChanged(upstreamUrl, 'env', fromEnv);
    return fromEnv;
  }
  const fromSystem = await resolveViaSystemProxy(upstreamUrl);
  logIfChanged(upstreamUrl, 'system', fromSystem);
  return fromSystem;
};

/** @internal 单测用:清空系统代理解析缓存与日志去重状态。 */
export function resetOutboundProxyResolverStateForTest(): void {
  systemProxyCache.clear();
  lastLoggedByOrigin.clear();
}
