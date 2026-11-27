/**
 * useHiddenPageAudioMute —— 内置浏览器页面看不见时静音它的声音（#9308）。
 *
 * 「看不见」取两路信号的「或」：
 *   - `tabVisible === false`：不是可见的顶层页签。切到别的页签、切到别的任务
 *     （后台任务的浏览器宿主仍常驻挂载，见 useRetainedBrowserTabHosts）、
 *     收起侧栏都会走到这里。
 *   - 宿主窗口最小化或隐藏：main 侧 `onWindowHiddenChange` 广播。不能只看
 *     `document.visibilityState`——有任务在跑时主窗关掉了 backgroundThrottling，
 *     最小化后它仍停在 'visible'（见 hiddenAnimationGate.ts）。
 *
 * 窗口只是失焦、或被别的应用遮住时不算看不见：用户可能一边听一边在别处工作。
 *
 * 只静音 guest 的音频输出（`<webview>.setAudioMuted`），页面继续运行、不重载，
 * 游戏进度与播放位置都保留。恢复时只撤销本 hook 自己加上的静音：静音前就已是
 * 静音的页面，恢复后仍保持静音。
 *
 * guest 尚未 attach 时 WebView 的 API 会抛错；此时等 `dom-ready` 再补一次。
 * Chromium 原生弹出窗口（useNativePopupSurface）不是 `<webview>`，不在本 hook 范围内。
 */

import { useEffect, useState } from 'react';
import type { WebviewTag } from 'electron';

import { isWindowHidden } from '@/lib/hiddenAnimationGate';

export function useHiddenPageAudioMute(webview: WebviewTag | null, tabVisible: boolean): void {
  const [windowHidden, setWindowHidden] = useState(() => isWindowHidden());

  useEffect(() => window.electronAPI?.onWindowHiddenChange?.(setWindowHidden), []);

  const shouldMute = !tabVisible || windowHidden;

  useEffect(() => {
    if (!webview || !shouldMute) return;
    let mutedHere = false;
    let mutedBefore = false;
    const mute = () => {
      if (mutedHere) return;
      try {
        mutedBefore = webview.isAudioMuted();
        webview.setAudioMuted(true);
        mutedHere = true;
      } catch {
        // guest 还没 attach：dom-ready 后重试。
      }
    };
    mute();
    webview.addEventListener('dom-ready', mute);
    return () => {
      webview.removeEventListener('dom-ready', mute);
      if (!mutedHere) return;
      try {
        webview.setAudioMuted(mutedBefore);
      } catch {
        // guest 已销毁（关闭页签 / 淘汰），无需恢复。
      }
    };
  }, [webview, shouldMute]);
}
