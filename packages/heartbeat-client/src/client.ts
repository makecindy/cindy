import type {
  HeartbeatClientOptions,
  HeartbeatHandle,
  HeartbeatLogger,
} from './types.js';

/**
 * 创建一个心跳客户端实例并立刻开始 tick。
 *
 * 设计契约 (与 apps/heartbeat-server 配套):
 *  - 单次失败 (网络错 / 5xx / 超时) 一律静默,只记 warn 不抛
 *  - 首次启动时**立刻**触发一次 tick,而不是等满 intervalMs 才发
 *    —— 否则用户打开 App 后最多要等一个 interval 才被算"在线"
 *  - host.getUid() 返回 null 时跳过本次 tick (不算失败),适用于登录态切换间隙
 *  - 没有 schedule jitter / no backoff / no retry —— 反正下一个 tick 还会再来,
 *    重试只会浪费电
 *  - 不依赖 Electron / Node 子系统,仅用注入的 fetchImpl(缺省 globalThis.fetch)
 *    + AbortSignal.timeout
 *
 * 调用方负责生命周期 (stop()) 与 uid 来源切换 (通过 getUid 动态返回不同 id)。
 */
export function createHeartbeatClient(opts: HeartbeatClientOptions): HeartbeatHandle {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.host.logger;
  const url = trimTrailingSlash(opts.endpoint) + '/heartbeat';

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const uid = opts.host.getUid();
    if (!uid) {
      log?.debug?.('[heartbeat] skip tick: no uid');
      return;
    }
    const body: Record<string, string> = { uid };
    const platform = opts.host.getPlatform?.();
    if (platform) body.platform = platform;
    const version = opts.host.getVersion?.();
    if (version) body.version = version;

    try {
      opts.onTick?.({ uid, platform: platform ?? undefined, version: version ?? undefined });
    } catch (err) {
      log?.warn?.('[heartbeat] onTick failed', toErrorSummary(err));
    }

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        log?.warn?.(`[heartbeat] non-2xx: ${res.status}`);
        return;
      }
      log?.debug?.('[heartbeat] ok');
    } catch (err) {
      // 一律 warn,绝不 error。统计场景下失败不算事故。
      log?.warn?.('[heartbeat] failed', toErrorSummary(err));
    }
  };

  // 立刻 fire 一次,而不是等满 interval
  void tick();
  timer = setInterval(() => {
    void tick();
  }, opts.intervalMs);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    get running() {
      return !stopped;
    },
  };
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function toErrorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return '<unprintable error>';
  }
}

// 仅用于类型,避免被 tree-shake 删除 HeartbeatLogger
export type { HeartbeatLogger };
