/**
 * ipcErrorToastText — 把调用方直接透传进错误提示的原始 IPC 异常改写成用户能读懂的文案。
 *
 * 很多功能在失败时直接 `toast.error(err.message)`，Electron 会把主进程异常包成
 * `Error invoking remote method 'device-link:invoke': Error: [CODE] …`，用户看到的是
 * 英文异常和 64 位设备 ID。逐个调用方修改覆盖不全，因此在提示入口统一处理：
 *
 * - 远程连接类错误码（`DEVICE_LINK_*`）且已有 `ipcError.<CODE>` 文案时，换成该文案：
 *   这类错误的细节只是设备 ID 与内部状态，对用户没有意义；
 * - 其它错误只去掉 Electron 的包装前缀，保留调用方原有的说明与错误码，不丢诊断信息。
 */
import { i18n } from '@/i18n';
import { extractIpcError, mapIpcErrorToI18nKey } from '../utils/ipcError';

import { setToastAlertTextFormatter } from './toast';

const ELECTRON_IPC_WRAPPER = /Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

export function formatIpcErrorToastText(
  message: string,
  translate: (key: string) => string | null,
): string {
  const wrapper = ELECTRON_IPC_WRAPPER.exec(message);
  if (!wrapper) return message;
  const before = message.slice(0, wrapper.index);
  const rest = message.slice(wrapper.index + wrapper[0].length);
  const error = new Error(rest);
  const ipcError = extractIpcError(error);
  const translated = ipcError?.code.startsWith('DEVICE_LINK_')
    ? translate(mapIpcErrorToI18nKey(error))
    : null;
  return before + (translated ?? rest);
}

export function installIpcErrorToastText(): void {
  setToastAlertTextFormatter((message) =>
    formatIpcErrorToastText(message, (key) => (i18n.exists(key) ? i18n.t(key) : null)),
  );
}
