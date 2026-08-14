/**
 * connect-failure — 连接阶段失败 → IPC code 分类。
 * 独立成纯模块是为了可单测(index.ts import electron)。
 */

import {
  isAuthFailure,
  KEY_FILE_NOT_FOUND_CODE,
  KEY_FILE_UNREADABLE_CODE,
  PINNED_AGENT_FAILED_CODE,
} from '@cindy/maker-remote-ssh';

export type ConnectFailureClass =
  | 'SSH_AUTH_FAILED'
  | 'SSH_KEY_FILE_NOT_FOUND'
  | 'SSH_CONNECT_FAILED';

/**
 * Classify a connect-phase failure into the IPC code the renderer can act on.
 *
 * Auth-shaped failures keep their existing `SSH_AUTH_FAILED` (actionable
 * ssh-copy-id hint). A *local* identity-file read failure (fs ENOENT from
 * `resolveAuth`) is a path problem — the configured private key doesn't exist
 * on disk — and must NOT be swallowed into the generic `SSH_CONNECT_FAILED`.
 * Everything else (network / handshake / server) stays `SSH_CONNECT_FAILED`.
 *
 * Classification keys off the error's stable local `.code` (set by
 * `resolveAuth`), NOT the message text — the message can originate from the
 * remote SSH server (e.g. a forged SSH_MSG_DISCONNECT description) and must
 * never drive classification. Returns the message too so callers can pass it
 * through without re-extracting it.
 */
export function classifyConnectFailure(err: unknown): { code: ConnectFailureClass; msg: string } {
  const msg = String((err as Error)?.message ?? err);
  // 轮 21-W2 MEDIUM:本地 key 三类确定性错误(不存在/不可读/pinned-agent 解析
  // 失败)统一归 SSH_KEY_FILE_NOT_FOUND(非重试、引导修本地配置)——
  // 不得落进 SSH_AUTH_FAILED(远端认证语义)或 SSH_CONNECT_FAILED(可重试语义)。
  const code = (err as { code?: unknown } | null)?.code;
  if (
    code === KEY_FILE_NOT_FOUND_CODE
    || code === KEY_FILE_UNREADABLE_CODE
    || code === PINNED_AGENT_FAILED_CODE
  ) {
    return { code: 'SSH_KEY_FILE_NOT_FOUND', msg };
  }
  if (isAuthFailure(msg)) return { code: 'SSH_AUTH_FAILED', msg };
  return { code: 'SSH_CONNECT_FAILED', msg };
}
