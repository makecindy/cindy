/**
 * 三方应用集成服务（integrations）当前开启了哪些官方应用。
 *
 * 端点清单只给这个服务一个地址 `integrationsBaseUrl`；哪些官方入口可见由服务端
 * `GET /integrations` 决定，新应用上线只需服务端打开开关。列表只影响尚未开启的用户能否
 * 看到入口：连接地址始终从 `integrationsBaseUrl` 派生，读取失败不会断开已开启的连接。
 *
 * 请求量：进程启动后读一次，不轮询；网络错误或非 2xx 按固定退避最多再试三次，之后等下次
 * 启动。清单地址只在启动时解析，运行期不会变化，因此不需要按地址变化重读。
 */

export const OFFICIAL_INTEGRATIONS = ['telegram', 'discord'] as const;
export type OfficialIntegration = (typeof OFFICIAL_INTEGRATIONS)[number];

export const INTEGRATIONS_PATH = '/integrations';
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];
const REQUEST_TIMEOUT_MS = 10_000;

export interface IntegrationsDirectoryDeps {
  /** `integrationsBaseUrl`（已去掉末尾斜杠）；空串表示清单未配置。 */
  getBaseUrl: () => string;
  /** 列表变化后调用，用来重发设置页快照。 */
  onChange: () => void;
  fetchImpl?: typeof fetch;
  log?: { warn: (message: string) => void };
  retryDelaysMs?: readonly number[];
}

export interface IntegrationsDirectory {
  /** 第一次调用发起读取，之后再调用不做任何事。 */
  start: () => void;
  isOffered: (integration: OfficialIntegration) => boolean;
  dispose: () => void;
}

function isOfficialIntegration(value: unknown): value is OfficialIntegration {
  return typeof value === 'string' && (OFFICIAL_INTEGRATIONS as readonly string[]).includes(value);
}

export function createIntegrationsDirectory(deps: IntegrationsDirectoryDeps): IntegrationsDirectory {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let offered: ReadonlySet<OfficialIntegration> = new Set();
  let started = false;
  let disposed = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const apply = (next: ReadonlySet<OfficialIntegration>): void => {
    if (next.size === offered.size && [...next].every((id) => offered.has(id))) return;
    offered = next;
    deps.onChange();
  };

  const scheduleRetry = (reason: string): void => {
    if (disposed || retries >= retryDelaysMs.length) {
      deps.log?.warn(`integrations list unavailable (${reason}); official entries stay as they are until restart`);
      return;
    }
    const delay = retryDelaysMs[retries++];
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void load();
    }, delay);
    retryTimer.unref?.();
  };

  const load = async (): Promise<void> => {
    const base = deps.getBaseUrl().trim();
    if (disposed || base.length === 0) return;
    let response: Response;
    try {
      response = await fetchImpl(`${base}${INTEGRATIONS_PATH}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      scheduleRetry(error instanceof Error ? error.name : 'network');
      return;
    }
    if (disposed) return;
    // 服务端还没有这个接口：部署前的版本只承载 Telegram。客户端可以先于服务端发布。
    if (response.status === 404) {
      apply(new Set(['telegram']));
      return;
    }
    if (!response.ok) {
      scheduleRetry(`HTTP ${response.status}`);
      return;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      scheduleRetry('invalid body');
      return;
    }
    const list = (body as { integrations?: unknown } | null)?.integrations;
    if (!Array.isArray(list)) {
      scheduleRetry('invalid body');
      return;
    }
    if (disposed) return;
    // 本版本不认识的应用（服务端以后新增的）直接忽略，不影响已知应用。
    apply(new Set(list.filter(isOfficialIntegration)));
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      void load();
    },
    isOffered: (integration) => offered.has(integration),
    dispose() {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}
