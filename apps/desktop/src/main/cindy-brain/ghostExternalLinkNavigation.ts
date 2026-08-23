import type { BrowserWindow, MessageBoxOptions, WebContents } from 'electron';

import type { GhostExternalLinkGate } from './previewGate.js';

export interface GhostExternalLinkNavigationLogger {
  debug(message: string, meta: Record<string, unknown>): void;
  warn(message: string, meta: Record<string, unknown>): void;
}

export interface GhostExternalLinkNavigationDeps {
  gate: GhostExternalLinkGate;
  resolveOwner(hostContents: WebContents): BrowserWindow | null;
  showMessageBox(owner: BrowserWindow, options: MessageBoxOptions): Promise<{ response: number }>;
  openExternal(url: string): Promise<void>;
  translate(key: string): string;
  logger: GhostExternalLinkNavigationLogger;
}

export interface GhostExternalLinkNavigationParams {
  ghostId: string;
  url: string;
  /** did-attach-webview 事件所属的宿主 renderer。 */
  hostContents: WebContents;
  /** 发起 will-navigate 的 Ghost guest。 */
  guestContents: WebContents;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function guestStillBelongsToHost(guestContents: WebContents, hostContents: WebContents): boolean {
  if (guestContents.isDestroyed() || hostContents.isDestroyed()) return false;
  return guestContents.hostWebContents === hostContents;
}

async function openExternalBestEffort(
  ghostId: string,
  url: string,
  deps: GhostExternalLinkNavigationDeps,
): Promise<void> {
  try {
    await deps.openExternal(url);
  } catch (error) {
    deps.logger.warn('ghost external link open failed', {
      ghostId,
      error: errorMessage(error),
    });
  }
}

/**
 * 执行一次 Ghost 主 frame 的 will-navigate 外链导航。
 *
 * 纯策略（URL、焦点、限速、授信域、确认防重入）由 GhostExternalLinkGate
 * 决定；这里仅协调 Electron 的原生确认框与系统浏览器。确认分支始终绑定
 * did-attach-webview 的真实宿主窗口，并在用户确认后重验 guest → host →
 * owner 整条归属链，避免窗口切换或销毁后把旧确认应用到别处。
 */
export async function runGhostExternalLinkNavigation(
  params: GhostExternalLinkNavigationParams,
  deps: GhostExternalLinkNavigationDeps,
): Promise<void> {
  const outcome = deps.gate.request({
    ghostId: params.ghostId,
    url: params.url,
    isPanelFocused: () => !params.guestContents.isDestroyed() && params.guestContents.isFocused(),
  });
  if (outcome.action === 'reject') {
    deps.logger.debug('ghost external link rejected', {
      ghostId: params.ghostId,
      reason: outcome.reason,
    });
    return;
  }
  if (outcome.action === 'direct-open') {
    await openExternalBestEffort(params.ghostId, outcome.url, deps);
    return;
  }

  // outcome.url 是 Gate 在弹窗前固化的规范化 URL；后续只使用这一个值。
  const confirmedUrl = outcome.url;
  let shouldOpen = false;
  try {
    if (!guestStillBelongsToHost(params.guestContents, params.hostContents)) return;
    const owner = deps.resolveOwner(params.hostContents);
    if (!owner || owner.isDestroyed()) return;

    let response: number;
    try {
      ({ response } = await deps.showMessageBox(owner, {
        type: 'question',
        title: deps.translate('ghostPanel.externalLinkConfirm.title'),
        message: deps.translate('ghostPanel.externalLinkConfirm.message'),
        detail: confirmedUrl,
        buttons: [
          deps.translate('ghostPanel.externalLinkConfirm.open'),
          deps.translate('ghostPanel.externalLinkConfirm.cancel'),
        ],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }));
    } catch (error) {
      deps.logger.warn('ghost external link confirmation failed', {
        ghostId: params.ghostId,
        error: errorMessage(error),
      });
      return;
    }
    if (response !== 0) return;
    if (!guestStillBelongsToHost(params.guestContents, params.hostContents)) return;
    if (owner.isDestroyed()) return;
    if (!deps.gate.isGhostAvailable(params.ghostId)) return;
    shouldOpen = true;
  } finally {
    deps.gate.releaseConfirmation(params.ghostId);
  }
  if (shouldOpen) {
    await openExternalBestEffort(params.ghostId, confirmedUrl, deps);
  }
}
