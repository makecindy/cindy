/**
 * ghostPanelWindow —— 「我是不是插件面板独立窗口」的窗口身份判定。
 *
 * 与 sidebarWindow.ts 同款:main 的窗口工厂在启动 URL 上带
 * `?ghostPanelWindow=<ghostId>`,renderer 启动时读一次;身份在窗口生命周期内
 * 不变。id 过校验(isValidGhostId)才算数,野值视同普通窗口。
 */

import { isValidGhostId } from '../../shared/ghost';

let cached: string | null | undefined;

/** 本窗口承载的 ghostId;非插件面板窗口返回 null。 */
export function getGhostPanelWindowGhostId(): string | null {
  if (cached === undefined) {
    const raw = new URLSearchParams(window.location.search).get('ghostPanelWindow');
    cached = isValidGhostId(raw) ? raw : null;
  }
  return cached;
}

export function isGhostPanelWindow(): boolean {
  return getGhostPanelWindowGhostId() !== null;
}

/** 仅测试用。 */
export function __resetGhostPanelWindowForTest(): void {
  cached = undefined;
}
