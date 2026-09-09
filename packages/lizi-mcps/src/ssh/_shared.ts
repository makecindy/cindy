/**
 * ssh/_shared.ts —— cindy_ssh 工具家族的共享 helper。
 *
 * 设计原则（规则 9：确定性进代码，不靠 prompt）：
 *  - 主机名解析、cwd 引号包装、输出截断、错误分类全部在这里用代码保证，
 *    agent 只负责传"用户想连哪台机、跑什么命令"。
 *  - 任何 error payload / 日志都不携带 command 原文——maker-remote-ssh 模块
 *    红线：调用方可能把密钥内联在命令里，回显会经统一日志路径落盘。
 */

import type { SshHostSnapshotLike, SshMcpDeps, SshPoolLike } from '../types.js';
import type { SshToolResult } from './registry.js';

// ── payload helpers（与 xdt-helper/_payload.ts 同形） ───────────────────────

export function okPayload(data: Record<string, unknown>): SshToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }) }],
  };
}

export function errorPayload(
  errorCode: SshErrorCode,
  hint: string,
  extra?: Record<string, unknown>,
): SshToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          errorCode,
          data: { hint, ...(extra ?? {}) },
        }),
      },
    ],
    isError: true,
  };
}

export type SshErrorCode =
  | 'HOST_NOT_FOUND'
  | 'AMBIGUOUS_HOST'
  | 'SSH_AUTH_FAILED'
  | 'SSH_KEY_FILE_NOT_FOUND'
  | 'SSH_AGENT_UNAVAILABLE'
  | 'SSH_CONFIG_AUTH_UNSUPPORTED'
  | 'SSH_CONNECT_FAILED'
  | 'EXEC_TIMEOUT'
  | 'PLUGIN_DISABLED'
  | 'INTERNAL';

// ── host resolution ─────────────────────────────────────────────────────────

/** ssh_list_hosts / HOST_NOT_FOUND 候选清单共用的精简视图。 */
const REDACTION_FAILURE_TEXT = 'SSH error details are unavailable.';

/** Fail closed if the host redactor is unavailable; never log either input. */
export function safeRedactSensitiveText(
  deps: Pick<SshMcpDeps, 'redactSensitiveText'>,
  snapshot: SshHostSnapshotLike,
  text: string,
): string {
  try {
    return deps.redactSensitiveText(snapshot, text);
  } catch {
    return REDACTION_FAILURE_TEXT;
  }
}

export function hostBrief(
  s: SshHostSnapshotLike,
  deps: Pick<SshMcpDeps, 'redactSensitiveText'>,
): Record<string, unknown> {
  return {
    id: s.config.id,
    hostname: s.config.hostname,
    port: s.config.port,
    user: s.config.user,
    authMethod: s.config.authMethod,
    status: s.status,
    ...(s.lastAuthLabel ? { lastAuthLabel: s.lastAuthLabel } : {}),
    ...(s.lastError ? { lastError: safeRedactSensitiveText(deps, s, s.lastError) } : {}),
  };
}

export type ResolveHostResult =
  | { ok: true; snapshot: SshHostSnapshotLike }
  | { ok: false; result: SshToolResult };

/**
 * 把用户口中的"某台机器"解析成已配置主机：
 *   1. alias（config.id）精确匹配 —— 唯一主键，直接命中；
 *   2. hostname（IP / 域名）精确匹配 —— 唯一命中放行，多命中要求改用 alias；
 *   3. 都没有 → HOST_NOT_FOUND，附现有主机清单引导用户去「设置 → 远程连接」添加
 *      （v1 刻意不支持连未配置的主机——那会退回"猜 key / 猜 agent"的老路）。
 */
export function resolveHost(
  pool: SshPoolLike,
  nameOrIp: string,
  deps: Pick<SshMcpDeps, 'redactSensitiveText'>,
): ResolveHostResult {
  const snapshots = pool.list();
  const byId = snapshots.find((s) => s.config.id === nameOrIp);
  if (byId) return { ok: true, snapshot: byId };

  const byHostname = snapshots.filter((s) => s.config.hostname === nameOrIp);
  if (byHostname.length === 1) return { ok: true, snapshot: byHostname[0] };
  if (byHostname.length > 1) {
    return {
      ok: false,
      result: errorPayload(
        'AMBIGUOUS_HOST',
        `hostname "${nameOrIp}" 命中多台已配置主机，请改用唯一的 alias（candidates 里的 id 字段）指定。`,
        { candidates: byHostname.map((snapshot) => hostBrief(snapshot, deps)) },
      ),
    };
  }

  return {
    ok: false,
    result: errorPayload(
      'HOST_NOT_FOUND',
      `"${nameOrIp}" 不在已配置的 SSH 主机里。请告知用户到「设置 → 远程连接」添加该主机（或确认 ~/.ssh/config 里的 alias 拼写），不要退回手拼 ssh 命令。`,
      { configuredHosts: snapshots.map((snapshot) => hostBrief(snapshot, deps)) },
    ),
  };
}

// ── output truncation ───────────────────────────────────────────────────────

export const OUTPUT_CAP_CHARS = 32_000;
const TAIL_KEEP = 8_000;
// marker 固定预算:head + marker + tail 严格 ≤ OUTPUT_CAP_CHARS(截断后的
// 返回长度是工具对外的上限契约,不能因插入标记而超出)。marker 实际 ~30-45
// 字符,64 给 dropped 位数留足余量。
const MARKER_RESERVE = 64;
const HEAD_KEEP = OUTPUT_CAP_CHARS - TAIL_KEEP - MARKER_RESERVE;

/** stdout / stderr 各自 cap，超限保头留尾,防单条 `cat 大文件` 炸上下文。 */
export function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_CAP_CHARS) return { text, truncated: false };
  const dropped = text.length - HEAD_KEEP - TAIL_KEEP;
  return {
    text:
      text.slice(0, HEAD_KEEP) +
      `\n...[truncated ${dropped} chars]...\n` +
      text.slice(text.length - TAIL_KEEP),
    truncated: true,
  };
}

// ── cwd wrapping ────────────────────────────────────────────────────────────

/** POSIX 单引号安全转义：' → '\''。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** cwd 存在时包装成 `cd '<cwd>' && (command)`，引号处理由代码保证。 */
export function wrapCwd(command: string, cwd?: string): string {
  if (!cwd) return command;
  return `cd ${shellQuote(cwd)} && (${command})`;
}

// ── error classification ────────────────────────────────────────────────────

/** RemoteHost.exec 超时错误的确定性签名（`${label} timed out after ${ms}ms`）。 */
const EXEC_TIMEOUT_RE = / timed out after \d+ms$/;
/** desktop throwIpcError 的 `[CODE] message` 前缀编码。 */
const IPC_CODE_RE = /^\[([A-Z0-9_]+)\]\s*/;

export interface ClassifiedSshError {
  errorCode: SshErrorCode;
  hint: string;
}

/**
 * best-effort 分类 deps.ensureReady / host.exec 抛出的错误。
 * 认证失败的 message 内含 authFailureHint 的可操作提示（如 ssh-copy-id 指引），
 * 去掉 main-only 凭证路径后透传进 hint 让 agent 转告用户——认证失败是确定性的，
 * 不要重试。
 */
export function classifySshError(
  err: unknown,
  deps: Pick<SshMcpDeps, 'redactSensitiveText'>,
  snapshot?: SshHostSnapshotLike,
): ClassifiedSshError {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = snapshot ? safeRedactSensitiveText(deps, snapshot, rawMessage) : rawMessage;

  if (EXEC_TIMEOUT_RE.test(message)) {
    return {
      errorCode: 'EXEC_TIMEOUT',
      hint:
        '命令执行超时。长任务请改成后台运行再轮询结果，例如 `nohup <cmd> > /tmp/task.log 2>&1 &`，随后用 ssh_exec 查看日志文件。',
    };
  }

  const codeMatch = IPC_CODE_RE.exec(message);
  const detail = codeMatch ? message.slice(codeMatch[0].length) : message;
  switch (codeMatch?.[1]) {
    case 'SSH_HOST_NOT_FOUND':
      return {
        errorCode: 'HOST_NOT_FOUND',
        hint: `主机不存在：${detail}。用 ssh_list_hosts 查看已配置主机。`,
      };
    case 'SSH_AUTH_FAILED':
      return {
        errorCode: 'SSH_AUTH_FAILED',
        hint: `SSH 认证失败（确定性错误，重试无效，请把提示转告用户处理）：${detail}`,
      };
    case 'SSH_KEY_FILE_NOT_FOUND':
      return {
        errorCode: 'SSH_KEY_FILE_NOT_FOUND',
        // Strip the raw-error prefix (identity file not found: ) so the hint
        // doesn't mix an English prefix into the localized message — same
        // treatment the renderer toast applies.
        hint: `配置的私钥文件在本机磁盘上不存在/不可读（本机路径问题，不是网络或服务端错误）：${detail.replace(/^identity file not found:\s*/, '')}。请到「设置 → 远程连接」重新选择私钥或编辑主机的 Identity file 路径。`,
      };
    case 'SSH_AGENT_UNAVAILABLE':
      return {
        errorCode: 'SSH_AGENT_UNAVAILABLE',
        hint: `SSH Agent 当前不可用（重复连接不会自行恢复）：${detail}。请启动 ssh-agent，并用 ssh-add 加载对应私钥后重试。`,
      };
    case 'SSH_CONFIG_AUTH_UNSUPPORTED':
      return {
        errorCode: 'SSH_CONFIG_AUTH_UNSUPPORTED',
        hint: `此主机的部分 SSH 配置规则超出 Cindy 当前支持的子集（重复连接无效，终端 SSH 仍可能成功）：${detail}。请检查 Match、条件 Include、IdentityAgent、IdentitiesOnly 和公钥设置。`,
      };
    default:
      return {
        errorCode: 'SSH_CONNECT_FAILED',
        hint: `SSH 连接/执行失败：${detail}。可用 ssh_host_status 查看主机状态后重试；反复失败请转告用户。`,
      };
  }
}
