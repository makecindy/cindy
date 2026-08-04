/**
 * agentProxyConfig — 「Agent 流量走 Proxy」的跨进程共享类型与校验。
 *
 * main (ssh-host-prefs-store / agent-proxy) / preload / renderer 三端共用,
 * 消除手写镜像类型的结构漂移风险 (变体字段不同, 漏同步时结构化类型会让
 * renderer 静默吞掉新字段)。纯类型 + 纯函数, 不依赖 electron / node API。
 */

/**
 * Agent 流量走 Proxy 的 per-host 配置, 两种模式:
 *   - mode='tunnel' (Cindy 代建隧道): 独立 SSH 连接维护
 *     `ssh -R <remotePort>:<localHost>:<localPort>`, 远端 agent env 指向
 *     http://127.0.0.1:<remotePort> (remotePort 为用户指定的固定端口)。
 *   - mode='env' (仅注入环境变量): 用户自己保证 proxyUrl 在远端可达,
 *     Cindy 只注入 env, 不建隧道。
 */
export type SshHostAgentProxyPref =
  | {
      enabled: boolean;
      mode: 'tunnel';
      localHost: string;
      localPort: number;
      /** 远端 127.0.0.1 固定绑定端口 (被占时等待/清理, 不顺延漂移)。 */
      remotePort: number;
    }
  | {
      enabled: boolean;
      mode: 'env';
      /** 远端可达的代理 URL, 如 http://127.0.0.1:7890 (在远端解析)。 */
      proxyUrl: string;
    };

/**
 * 隧道/应用的实时状态 (内存态, UI 卡片展示):
 *   connecting/active/port-busy/paused 来自代建隧道保活器;
 *   error 也可能来自 marker 对账失败 (env 模式同样会落)。
 */
export interface AgentProxyTunnelState {
  phase: 'connecting' | 'active' | 'port-busy' | 'error' | 'paused';
  remotePort?: number;
  lastError?: string;
}

/**
 * 旧 pref ({enabled,localHost,localPort} 无 mode, PR #715 动态端口方案)
 * 迁移用的固定远端端口缺省值 — 旧动态分配的首选基数, 多数存量 daemon 的
 * marker 本来就指向它, 迁移后通常无需重启 daemon。
 */
export const LEGACY_AGENT_PROXY_REMOTE_PORT = 17893;

/** env 模式允许的代理 URL scheme (reqwest / node / curl 的公约数)。 */
const PROXY_URL_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

/**
 * Produce a safe diagnostic representation of a possibly-invalid proxy URL.
 * This is intentionally separate from validation: rejected values must still
 * never be copied verbatim into logs because they may contain userinfo.
 */
export function redactAgentProxyUrlForLog(raw: unknown): string {
  if (typeof raw !== 'string') return '[redacted]';
  if (!raw.trim() || /\s/.test(raw)) return '[redacted]';
  try {
    const url = new URL(raw.trim());
    if (!PROXY_URL_SCHEMES.has(url.protocol) || !url.hostname) return '[redacted]';
    return `${url.protocol}//${url.host}`;
  } catch {
    return '[redacted]';
  }
}

/**
 * 校验 env 模式的 proxyUrl; 非法返回 null。main 的 prefs/IPC 与 renderer
 * 表单共用同一口径 — 两套标准会让用户填了合法表象却被 IPC 打回。
 */
export function normalizeAgentProxyUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // 引号/空白拒收: 值会进远端 shell marker 文件 (单引号包裹), 脏值晚到
  // 远端才失败, 难排查。
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes("'") || trimmed.includes('"')) return null;
  try {
    const url = new URL(trimmed);
    if (!PROXY_URL_SCHEMES.has(url.protocol)) return null;
    if (!url.hostname) return null;
    // 拒 userinfo (http://user:pass@host): 该值会持久化 + 写远端 marker 文件,
    // 内嵌凭证会被当成非机密落盘/进日志 (review: PR #992 greptile P1)。
    // 需要认证的代理让用户改用本机代理转发, 不接受凭证内嵌。
    if (url.username || url.password) return null;
    return trimmed;
  } catch {
    return null;
  }
}
