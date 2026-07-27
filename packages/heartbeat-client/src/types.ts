/**
 * 注入给 client 的最小化主机 (host) 能力。
 * Electron 主进程、Node 服务、浏览器都能实现这套接口,所以 client 本身保持环境无关。
 */
export interface HeartbeatHost {
  /**
   * 返回当前要上报的 uid 字符串。
   * - 已登录: 返回 user.id
   * - 未登录: 返回 deviceId / 匿名 id 也可以
   * - 暂时拿不到 (登录态在切换): 返回 null,本次 tick 跳过上报
   *
   * 每次 tick 都会调,可以动态变化。返回 null 时不计入失败。
   */
  getUid: () => string | null;

  /**
   * 可选: 平台标识,会作为 body.platform 字段透传。便于 server 端 / TapDB 维度切分。
   * 一般传 process.platform 或 'desktop' / 'web'。
   */
  getPlatform?: () => string | null;

  /**
   * 可选: 应用版本号,会作为 body.version 字段透传。
   */
  getVersion?: () => string | null;

  /**
   * 可选 logger。不传则完全静默 (符合"统计场景失败不打扰"的契约)。
   */
  logger?: HeartbeatLogger;
}

/**
 * 与 pino / console / electron-log 都兼容的最小日志接口。
 * 只要求 debug / info / warn 三档,error 也走 warn (心跳上报失败永远不是 error 级别)。
 */
export interface HeartbeatLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/** 一次有效 heartbeat tick 的上下文,供宿主复用同一节拍做轻量本地任务。 */
export interface HeartbeatTickPayload {
  uid: string;
  platform?: string;
  version?: string;
}

export interface HeartbeatClientOptions {
  /** heartbeat-server 完整地址,例如 https://heartbeat.example.com */
  endpoint: string;
  /** 心跳间隔毫秒。建议 60000 (与 server ONLINE_TTL_SEC=90 配合,保留 30s 容错) */
  intervalMs: number;
  /** 单次请求超时毫秒,默认 5000 */
  timeoutMs?: number;
  host: HeartbeatHost;
  /**
   * 每次有效心跳 tick 触发一次。调用发生在网络请求前,因此不依赖 heartbeat-server 成功。
   * 适合复用 heartbeat 的节拍做本地轻量任务,但回调异常不会中断心跳上报。
   */
  onTick?: (payload: HeartbeatTickPayload) => void;
  /**
   * 出网通道。缺省 = `globalThis.fetch`。注意 **Node / Electron 主进程**下它是 undici,
   * 不读系统代理设置也不读代理环境变量;需要经代理出网的宿主要注入自己的实现
   * (desktop 注入 main/maker-host/outbound-fetch)。浏览器环境不受此影响 —— 那里的
   * fetch 走浏览器网络栈,系统代理天然生效。
   */
  fetchImpl?: typeof fetch;
}

/** start() 返回的句柄,允许停止与状态查询。 */
export interface HeartbeatHandle {
  /** 立刻停止后续 tick,正在飞的请求不会被 abort (反正完成也只是个日志事件) */
  stop: () => void;
  /** 是否正在运行 (start 之后、stop 之前) */
  readonly running: boolean;
}
