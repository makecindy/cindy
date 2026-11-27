/**
 * broadcastTargets — 筛选 `maker:*` 推送事件的目标窗口。
 *
 * 只有加载主应用 / 副窗 / 独立右侧栏 preload 的 app-content 窗口订阅 `maker:*`
 * push 通道；Ghost 沙箱、语音浮层、区域截图/贴图、远端桌面采集/查看器、登录弹窗、
 * 托盘面板、原生 popup 及预热隐藏的「资源用量」窗口都不监听这些通道。过滤掉它们
 * 可避免每个流式 token delta 对所有无关 BrowserWindow 重复做 structured-clone 和 IPC。
 */

import type { BrowserWindow } from 'electron';

import { isResourceUsageWebContentsId } from '../resource-usage-window/registry.js';
import { isAppContentWindow } from '../windowFocusClassifier.js';

export interface MakerBroadcastTargetDeps {
  isAppContentWindow?: (win: BrowserWindow) => boolean;
  isResourceUsageWebContentsId?: (webContentsId: number) => boolean;
}

export function shouldReceiveMakerBroadcast(
  win: BrowserWindow | null | undefined,
  deps: MakerBroadcastTargetDeps = {},
): win is BrowserWindow {
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return false;
  const checkAppContent = deps.isAppContentWindow ?? isAppContentWindow;
  if (!checkAppContent(win)) return false;
  const checkResourceUsage = deps.isResourceUsageWebContentsId ?? isResourceUsageWebContentsId;
  if (typeof wc.id === 'number' && checkResourceUsage(wc.id)) return false;
  return true;
}

export function selectMakerBroadcastTargets(
  windows: readonly BrowserWindow[],
  deps: MakerBroadcastTargetDeps = {},
): BrowserWindow[] {
  const targets: BrowserWindow[] = [];
  for (const win of windows) {
    if (shouldReceiveMakerBroadcast(win, deps)) {
      targets.push(win);
    }
  }
  return targets;
}
