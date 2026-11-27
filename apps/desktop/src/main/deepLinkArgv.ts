import { DEEP_LINK_PRIMARY_SCHEME, matchDeepLinkPrefix } from '../shared/deepLinkSchemes';

/**
 * Windows 第二实例 / 冷启动 argv 解析:从命令行参数末尾找形如 cindy://... /
 * xdt-maker://... 的项(两种 scheme 都认)。
 * Electron 在 Windows 上把协议 URL 作为 argv 最后一项追加;macOS 不走 argv,走
 * app.on('open-url')。Linux 依赖 .desktop 的 Exec 参数传递协议 URL;首版只做
 * 打包 metadata,实际导航行为仍需要 Ubuntu 真机验收。
 */
export function findDeepLinkInArgv(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i];
    if (typeof arg === 'string' && matchDeepLinkPrefix(arg) !== null) return arg;
  }
  return null;
}

/**
 * Remove all provider-import arguments (even invalid/unselected ones), plus every
 * copy of the consumed URL. The caller retains the selected URL for delivery.
 * This sanitizes JS argv and future copies, not the OS's original command line.
 */
export function redactConsumedDeepLinkInArgv(argv: string[], deepLink?: string): void {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const arg = argv[i];
    const prefix = typeof arg === 'string' ? matchDeepLinkPrefix(arg) : null;
    if (arg !== deepLink && !(prefix && /^(chat-invite\/|provider\/|provider-share\/|shared-task\/|shared-session\?)/.test(arg.slice(prefix.length)))) continue;
    argv[i] = `${DEEP_LINK_PRIMARY_SCHEME}://consumed`;
  }
}
