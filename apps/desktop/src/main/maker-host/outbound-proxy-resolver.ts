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
 *
 * 除日志外还留一份**旁路快照**(getLastOutboundPathSnapshot):日志用户看不到,而
 * 「当前到底走没走代理」恰恰是上游不可达时最该告诉用户的一句话。快照只被诊断读取,
 * 不参与任何转发决策 —— 转发行为与扩展前逐字节一致。快照刻意把「解析超时 / 解析
 * 失败 / app 未 ready」记成 `unknown` 而不是 `direct`:这三种情况下我们是 fail-open
 * 猜了直连,而不是确认了无代理,把猜测显示成事实会把排查带向反方向(高墙网络里
 * 直连必然失败,用户却以为代理判定正常)。
 */

import { app, session } from 'electron';

import {
  createEnvOutboundProxyResolver,
  hasProxyEnvConfig,
  parseOutboundProxyUrl,
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
 *
 * `skippedUnsupported` 记录「跳过了至少一个配置了但本实现用不了的条目」。它对转发
 * 决策没有影响(照旧直连),但对诊断是决定性的:`HTTPS corporate.proxy:443` 这种
 * 结果说明**系统确实配了代理、只是 Cindy 用不了**,与「系统报告无代理」是两回事,
 * 报成后者会把用户的排查方向带反。
 */
export interface ChromiumProxyVerdict {
  /** 选中的代理地址(http:// 或 socks5://);没有可用条目 → null(直连)。 */
  url: string | null;
  /** 是否跳过了 HTTPS(TLS-to-proxy)/ 裸 SOCKS(v4)这类不支持的已配置条目。 */
  skippedUnsupported: boolean;
}

export function parseChromiumProxyResult(result: string): ChromiumProxyVerdict {
  let socks5Fallback: string | null = null;
  let skippedUnsupported = false;
  for (const rawEntry of result.split(';')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const spaceIdx = entry.indexOf(' ');
    const kind = (spaceIdx === -1 ? entry : entry.slice(0, spaceIdx)).toUpperCase();
    if (kind === 'DIRECT') break;
    const hostPort = spaceIdx === -1 ? '' : entry.slice(spaceIdx + 1).trim();
    if (!hostPort) continue;
    if (kind === 'PROXY') return { url: `http://${hostPort}`, skippedUnsupported };
    // 先记下第一个 SOCKS5;扫完(或遇到 DIRECT)确认没有 PROXY 候选才用它。
    if (kind === 'SOCKS5') {
      socks5Fallback ??= `socks5://${hostPort}`;
      continue;
    }
    // HTTPS / SOCKS(v4)/ 其它未知前缀:带了地址却用不了 —— 记下来给诊断。
    skippedUnsupported = true;
  }
  return { url: socks5Fallback, skippedUnsupported };
}

/**
 * 「没问出系统代理判定」的原因。存在这一态是本模块的诊断前提:这些分支下返回的
 * `null` 是 fail-open 的猜测,不等于「确认无代理」。
 */
export type OutboundPathUnknownReason =
  | 'resolve_timeout'
  | 'resolve_failed'
  | 'app_not_ready'
  | 'session_unavailable';

/**
 * 出站路径类别。四态刻意分开 —— 它们的**实际行为只有直连或走代理两种,但原因完全
 * 不同**,而原因才是诊断要说的话:
 *   - proxy       走代理,且该地址**转发层确实能用**
 *   - direct      没有代理配置(env 无、系统解析器给了直连)
 *   - unsupported 配了代理但转发层用不了,故实际直连。两种来源:系统侧返回
 *                 HTTPS(TLS-to-proxy)/ SOCKS(v4)条目;env 侧写了同类形态的值
 *                 (`HTTPS_PROXY=https://…`、`socks4://…`),被 parseOutboundProxyUrl 拒收。
 *   - unknown     判定没问出来(超时 / 异常 / app 未 ready),按直连兜底
 *
 * 判定 proxy 的唯一依据是转发层的 parseOutboundProxyUrl —— resolver 返回了字符串
 * 不代表转发层能用它,按字符串非空就报 proxy 会让诊断谎称走了代理。
 */
export type OutboundPathKind = 'proxy' | 'direct' | 'unsupported' | 'unknown';

/** 出站路径旁路快照 —— 仅供诊断展示,不参与转发决策。 */
export interface OutboundPathSnapshot {
  /** 判定来源:env = 代理环境变量;system = Electron 系统代理 / PAC。 */
  source: 'env' | 'system';
  kind: OutboundPathKind;
  /** kind='proxy' 时的**脱敏**代理地址(scheme://host:port),绝不含 userinfo。 */
  proxy?: string;
  /** kind='unknown' 时的具体原因。 */
  reason?: OutboundPathUnknownReason;
  /** 该判定对应的上游 origin(诊断展示时说明这条事实属于哪个上游)。 */
  upstream: string;
  at: number;
}

interface CachedResolution {
  value: string | null;
  /**
   * 该缓存值是「问出来的」还是「没问出来的兜底」。必须跟着缓存走:否则缓存命中时
   * 快照会把当初的 unknown 兜底重新报成 direct。
   */
  unknownReason?: OutboundPathUnknownReason;
  /**
   * 该次解析是否跳过了「配了但不支持」的系统代理条目。同样必须跟着缓存走 ——
   * 否则缓存命中时会把 unsupported 降级报成 direct。
   */
  skippedUnsupported?: boolean;
  expiresAt: number;
}

/**
 * 缓存条目上限。调用方可以按「origin + path」解析(PAC 允许按路径判定),条目数因此
 * 与被访问的路径数同阶;满了整体重建(下一轮按 TTL 重新解析),不做 LRU。
 */
const SYSTEM_PROXY_CACHE_MAX_ENTRIES = 256;

const systemProxyCache = new Map<string, CachedResolution>();
// 每个 origin 上次记录过日志的生效值;仅在变化时记 info,避免 per-request 刷日志。
const lastLoggedByOrigin = new Map<string, string>();

/** 日志维度恒为 origin:path 可能带业务语义,且按 path 去重会把日志刷成噪音。 */
function originForLog(upstreamUrl: string): string {
  try {
    const u = new URL(upstreamUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return upstreamUrl;
  }
}

function logIfChanged(upstreamUrl: string, source: 'env' | 'system', value: string | null): void {
  const origin = originForLog(upstreamUrl);
  // env 值可能是 http://user:pass@host 形态,持久化日志只允许脱敏形态(scheme://host:port)。
  const rendered = value === null ? 'direct' : redactProxyUrlForLog(value);
  if (lastLoggedByOrigin.get(origin) === `${source}:${rendered}`) return;
  if (lastLoggedByOrigin.size >= SYSTEM_PROXY_CACHE_MAX_ENTRIES) lastLoggedByOrigin.clear();
  lastLoggedByOrigin.set(origin, `${source}:${rendered}`);
  log.info('outbound proxy resolved', { upstream: origin, source, proxy: rendered });
}

/** resolveProxy 自身的上限。Chromium 侧卡住时不能让调用方无界等待。 */
const SYSTEM_PROXY_RESOLVE_TIMEOUT_MS = 2000;
/**
 * 解析超时后按直连缓存的时长。必须写缓存(而不是什么都不写):否则每个请求都会再发一次
 * resolveProxy,把已经卡住的解析路径打爆(IPC / Promise 堆积)。TTL 取短值,让代理软件
 * 恢复后几秒内自动回到正常判定。
 */
const SYSTEM_PROXY_TIMEOUT_CACHE_TTL_MS = 5000;

interface TimedProxyResolution {
  value: string | null;
  timedOut: boolean;
  /** 见 ChromiumProxyVerdict.skippedUnsupported;超时分支下无意义(恒 false)。 */
  skippedUnsupported: boolean;
}

/** 给 resolveProxy 套超时:超时返回 null 并告知调用方这是超时(用于短 TTL 缓存)。 */
async function resolveProxyWithTimeout(
  ses: { resolveProxy(url: string): Promise<string> },
  upstreamUrl: string,
): Promise<TimedProxyResolution> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<TimedProxyResolution>([
      ses.resolveProxy(upstreamUrl).then((result) => {
        const verdict = parseChromiumProxyResult(result);
        return {
          value: verdict.url,
          timedOut: false,
          skippedUnsupported: verdict.skippedUnsupported,
        };
      }),
      new Promise<TimedProxyResolution>((resolve) => {
        timer = setTimeout(
          () => resolve({ value: null, timedOut: true, skippedUnsupported: false }),
          SYSTEM_PROXY_RESOLVE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SystemProxyResolution {
  value: string | null;
  /** 有值 = 这次的 null 是 fail-open 兜底,不是「确认无代理」。 */
  unknownReason?: OutboundPathUnknownReason;
  /** true = 系统列了代理但形态不支持,直连是「用不了」而非「没配」。 */
  skippedUnsupported?: boolean;
}

async function resolveViaSystemProxy(upstreamUrl: string): Promise<SystemProxyResolution> {
  const cached = systemProxyCache.get(upstreamUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      value: cached.value,
      unknownReason: cached.unknownReason,
      skippedUnsupported: cached.skippedUnsupported,
    };
  }
  if (systemProxyCache.size >= SYSTEM_PROXY_CACHE_MAX_ENTRIES) systemProxyCache.clear();
  // app 未 ready 时 session 不可用;此时按直连处理(splash 极早期,正常请求不会赶在这)。
  // 不写缓存:app ready 是单向状态,缓存下来只会让 ready 之后的判定继续用兜底值。
  if (!app.isReady()) return { value: null, unknownReason: 'app_not_ready' };
  const ses = session.defaultSession;
  if (!ses || typeof ses.resolveProxy !== 'function') {
    return { value: null, unknownReason: 'session_unavailable' };
  }
  let value: string | null = null;
  let unknownReason: OutboundPathUnknownReason | undefined;
  let skippedUnsupported = false;
  try {
    const resolved = await resolveProxyWithTimeout(ses, upstreamUrl);
    value = resolved.value;
    skippedUnsupported = resolved.skippedUnsupported;
    if (resolved.timedOut) {
      unknownReason = 'resolve_timeout';
      log.warn('system proxy resolution timed out — using direct connection', {
        upstream: originForLog(upstreamUrl),
        timeoutMs: SYSTEM_PROXY_RESOLVE_TIMEOUT_MS,
      });
    }
  } catch (err) {
    unknownReason = 'resolve_failed';
    log.warn('system proxy resolution failed — using direct connection', {
      upstream: originForLog(upstreamUrl),
      err: err instanceof Error ? err.message : String(err),
    });
    value = null;
  }
  // 超时也写缓存,只是 TTL 短得多 —— 否则后续每个请求都会再打一次已经卡住的解析。
  systemProxyCache.set(upstreamUrl, {
    value,
    unknownReason,
    skippedUnsupported,
    expiresAt:
      Date.now() + (unknownReason ? SYSTEM_PROXY_TIMEOUT_CACHE_TTL_MS : SYSTEM_PROXY_CACHE_TTL_MS),
  });
  return { value, unknownReason, skippedUnsupported };
}

// 惰性初始化:单测可能对 @cindy/anthropic-compat-proxy 做部分 mock(如 codexProxyHost
// 测试只 mock 了 createAnthropicCompatProxy),模块加载期不能调用包函数。
let _envResolver: ((upstreamUrl: string) => string | null) | null = null;
function envResolver(upstreamUrl: string): string | null {
  _envResolver ??= createEnvOutboundProxyResolver();
  return _envResolver(upstreamUrl);
}

/**
 * 出站路径判定快照,**按调用方给的原始 upstream 键分桶**。
 *
 * 必须分桶而不能存单值:这个 resolver 是共享的(codex proxy、anthropic-compat
 * proxy、通用 outbound-fetch 都在调),单值槽会被最后一个完成解析的请求覆盖。
 * 而 `NO_PROXY` 与 PAC 都可以逐上游给出不同判定,于是诊断可能报出一条属于无关
 * 上游、甚至与故障上游结论相反的路径。
 *
 * 键刻意保留调用方传进来的原始形态,不归一成 origin:两个消费方的粒度本来就不同 ——
 * compat-proxy 的转发层按 origin 解析,而 outbound-fetch 按「origin + path」解析
 * (见其 `resolveKeyOf`,per-path PAC 靠它)。归一成 origin 会让同 origin、不同
 * requestPath 的两个 chat-bridge 会话互相覆盖判定。展示侧仍只用 origin(见
 * snapshot.upstream),不把 path 带进用户可见消息。
 *
 * 上限与 systemProxyCache 同量级;满了整体清空(下一轮请求会重新填)。
 */
const outboundPathByKey = new Map<string, OutboundPathSnapshot>();

function recordOutboundPath(
  upstreamUrl: string,
  source: 'env' | 'system',
  value: string | null,
  opts: {
    unknownReason?: OutboundPathUnknownReason;
    skippedUnsupported?: boolean;
  } = {},
): void {
  const origin = originForLog(upstreamUrl);
  if (
    outboundPathByKey.size >= SYSTEM_PROXY_CACHE_MAX_ENTRIES
    && !outboundPathByKey.has(upstreamUrl)
  ) {
    outboundPathByKey.clear();
  }
  // 关键:kind 必须反映**转发层实际会做什么**,不是 resolver 返回了什么字符串。
  // resolver 可以返回一个转发层根本用不了的地址(env 里写 HTTPS_PROXY=https://…
  // 的 TLS-to-proxy,或 socks4://),转发层的 parseOutboundProxyUrl 会拒收并直连 ——
  // 此时报「已经过 X 代理」就是在撒谎。用同一个解析器判定,谎报不了。
  const usable = value ? parseOutboundProxyUrl(value) : null;
  // 优先级:没问出来(unknown)> 转发层能用的代理(proxy)> 配了但用不了(unsupported)
  // > 确认没有代理配置(direct)。unsupported 必须压在 direct 之前 —— 两者的实际行为
  // 都是直连,但「列了代理却用不了」和「没有代理」是完全不同的排查方向。
  const kind: OutboundPathKind = opts.unknownReason
    ? 'unknown'
    : usable
      ? 'proxy'
      : value || opts.skippedUnsupported
        ? 'unsupported'
        : 'direct';
  outboundPathByKey.set(upstreamUrl, {
    source,
    kind,
    // 只在转发层真能用时报地址,且只报脱敏形态(env 值可能带 user:pass)。
    // usable.url 已是规范化后的无 userinfo 形态,再过一次脱敏是纵深防御。
    ...(opts.unknownReason ? { reason: opts.unknownReason } : {}),
    ...(usable && !opts.unknownReason ? { proxy: redactProxyUrlForLog(usable.url) } : {}),
    upstream: origin,
    at: Date.now(),
  });
}

/**
 * 取**指定上游**的出站路径判定;都没有记录过则返回 null。
 *
 * 入参收候选列表而不是单个值:调用方的实际上游可能随凭证模式动态切换(codex 订阅
 * 直连打 ChatGPT,网关模式打 gateway),但都属于同一个消费方;而且调用方手里通常是
 * 带 path 的 base URL,与快照键的粒度不一定一致,所以这里按 origin 归组匹配。
 *
 * **同一个 origin 下有多条判定且结论不一致时返回 null。** PAC 允许逐 path 给出不同
 * 判定,此时无法确定失败的那次请求走的是哪一条 —— 报其中任意一条(哪怕是最新的)
 * 都可能属于另一条 path。这条路径上宁可不报,也不能谎报。
 *
 * 注意冲突判定只在**组内**(同 origin):候选之间本来就允许不同(订阅直连与网关是
 * 两个 origin、判定天然可以不同),跨组按 `at` 取最新。
 *
 * 只读诊断用途:上游不可达时把「当前走的是代理 / 直连 / 配了但用不了 / 判定没问
 * 出来」这句事实交给用户,比让他猜快得多。返回的 proxy 字段已脱敏,可直接进错误
 * 消息与日志。
 */
export function getOutboundPathSnapshotFor(
  upstreamCandidates: readonly string[],
): OutboundPathSnapshot | null {
  const wanted = new Set(upstreamCandidates.map((raw) => originForLog(raw)));
  const byOrigin = new Map<string, OutboundPathSnapshot>();
  for (const snap of outboundPathByKey.values()) {
    if (!wanted.has(snap.upstream)) continue;
    const prev = byOrigin.get(snap.upstream);
    if (!prev) {
      byOrigin.set(snap.upstream, snap);
      continue;
    }
    // 一致性只看结论(走哪个代理 / 哪一类);unknown 的具体 reason 不同不算冲突。
    if (prev.kind !== snap.kind || prev.proxy !== snap.proxy) return null;
    if (snap.at > prev.at) byOrigin.set(snap.upstream, snap);
  }
  let best: OutboundPathSnapshot | null = null;
  for (const snap of byOrigin.values()) {
    if (!best || snap.at > best.at) best = snap;
  }
  return best;
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
    recordOutboundPath(upstreamUrl, 'env', fromEnv);
    return fromEnv;
  }
  const fromSystem = await resolveViaSystemProxy(upstreamUrl);
  logIfChanged(upstreamUrl, 'system', fromSystem.value);
  recordOutboundPath(upstreamUrl, 'system', fromSystem.value, {
    unknownReason: fromSystem.unknownReason,
    skippedUnsupported: fromSystem.skippedUnsupported,
  });
  return fromSystem.value;
};

/** @internal 单测用:清空系统代理解析缓存、日志去重与路径快照状态。 */
export function resetOutboundProxyResolverStateForTest(): void {
  systemProxyCache.clear();
  lastLoggedByOrigin.clear();
  outboundPathByKey.clear();
}
