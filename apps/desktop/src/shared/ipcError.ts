import { isIpcError, isIpcErrorCode, type IpcError } from './ipc-errors';

const IPC_ERROR_MESSAGE_RE = /(?:^|: Error: )\[([A-Z0-9_]+)\]\s*([\s\S]*)$/;

export const CODEX_IMAGE_INPUT_UNSUPPORTED = 'CODEX_IMAGE_INPUT_UNSUPPORTED';

export function extractIpcError(err: unknown): IpcError | null {
  if (isIpcError(err)) {
    return { code: err.code, message: err.message };
  }
  if (!(err instanceof Error)) return null;
  const match = IPC_ERROR_MESSAGE_RE.exec(err.message);
  if (!match) return null;
  const code = match[1];
  if (!isIpcErrorCode(code)) return null;
  return { code, message: match[2] };
}

/**
 * 识别对端明确缺少某可选只读接口的回执（返回规范化 `[CODE] message`；其它错误一律返回 `null`）：
 * - 对端 `REMOTE_INVOKE_ALLOWLIST` 未收录本次请求通道：`channel '<channel>' not allowed remotely`；
 * - `allowMissingHandler !== false` 时，对端未注册本次通道的本机 handler：`no local IPC handler for channel '<channel>'`。
 *
 * 本机传输策略（仅加密连接/未证明传输等 `CHANNEL_NOT_ALLOWED`）、非 owner 链路拒绝、
 * 共享任务作用域拒绝（`channel '<channel>' not allowed`）、普通权限/前置条件、Host client 模式不支持、
 * 业务对象不存在、超时与背压均返回 `null`，确保策略或权限恢复后下次读取仍会发送。
 */
export function extractRemoteOptionalReadMiss(
  err: unknown,
  channel: string,
  options?: { allowMissingHandler?: boolean },
): string | null {
  const ipc = extractIpcError(err);
  let code: string | undefined = ipc?.code;
  let rawMessage: string | undefined = ipc?.message;
  if (!code && err instanceof Error) {
    const match = IPC_ERROR_MESSAGE_RE.exec(err.message);
    if (match) {
      code = match[1];
      rawMessage = match[2];
    }
  }
  if (!code || rawMessage === undefined) return null;
  const stripped = IPC_ERROR_MESSAGE_RE.exec(rawMessage);
  const message = (stripped && stripped[1] === code ? stripped[2] : rawMessage).trim();
  if (
    options?.allowMissingHandler !== false &&
    code === 'NOT_FOUND' &&
    message === `no local IPC handler for channel '${channel}'`
  ) {
    return `[NOT_FOUND] ${message}`;
  }
  if (
    (code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' || code === 'CHANNEL_NOT_ALLOWED') &&
    message === `channel '${channel}' not allowed remotely`
  ) {
    return `[${code}] ${message}`;
  }
  return null;
}

/**
 * A Cindy Host refuses with PRECONDITION_FAILED and this reason marker while a Cindy desktop app
 * running on its own uses the same data (the Host's coexistence plan A): `HOST_PROFILE_IN_USE_BY_DESKTOP`
 * while it runs, `HOST_PROFILE_IN_USE_BY_DESKTOP_AT_START` when its start was refused
 * (host-ipc-proxy.ts). Only the marker at the start of the message counts.
 */
const HOST_PROFILE_IN_USE_RE = /^(?:\[PRECONDITION_FAILED\]\s*)?HOST_PROFILE_IN_USE_BY_DESKTOP(_AT_START)?(?::|$)/;

/**
 * The i18n key for that refusal, or null for any other error. `send` words the running case for a
 * failed send ("then send again"); anything else gets "then try again".
 */
export function hostProfileHoldI18nKey(err: unknown, use: 'send' | 'other' = 'other'): string | null {
  const ipcError = extractIpcError(typeof err === 'string' ? new Error(err) : err);
  if (ipcError?.code !== 'PRECONDITION_FAILED') return null;
  const match = HOST_PROFILE_IN_USE_RE.exec(ipcError.message);
  if (!match) return null;
  if (match[1]) return 'logic.errors.hostProfileInUseByDesktopAtStart';
  return use === 'send' ? 'logic.errors.hostProfileInUseByDesktop' : 'logic.errors.hostProfileInUseByDesktopRetry';
}

export const hostProfileInUseI18nKey = hostProfileHoldI18nKey;

export function mapIpcErrorToI18nKey(
  err: unknown,
  options?: { namespace?: string; fallback?: string },
): string {
  const held = hostProfileHoldI18nKey(err);
  if (held) return held;
  const ipcError = extractIpcError(err);
  if (!ipcError) return options?.fallback ?? 'ipcError.unknown';
  return `${options?.namespace ?? 'ipcError'}.${ipcError.code}`;
}
