/**
 * BannerOverlay — 全局横幅浮层容器 + Portal hook。
 *
 * 所有内嵌横幅（ErrorBanner、UpgradeBanner、WorktreeRestoreBanner 等）通过
 * useBannerPortal() 将视觉输出渲染到此容器中，从右上角滑入弹出。
 *
 * 定位：inset-0 flex items-center justify-center（屏幕居中）。
 * z-[10050]：低于 Toast(z-[10100])，高于 Dialog(z-[10000])。
 */

import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const BANNER_OVERLAY_ID = 'banner-overlay';

/**
 * 返回一个 portal 函数，横幅组件用它把内容渲染到全局浮层。
 * 目标 DOM 节点不存在时回退为内联渲染（测试环境 / SSR 安全）。
 */
export function useBannerPortal(): (children: ReactNode) => ReactNode {
  return (children) => {
    const target = document.getElementById(BANNER_OVERLAY_ID);
    if (!target) return children;
    return createPortal(children, target);
  };
}

export function BannerOverlay() {
  return (
    <div
      id={BANNER_OVERLAY_ID}
      aria-label="Banner notifications"
      className="pointer-events-none fixed inset-0 z-[10050] flex flex-col items-center justify-center gap-3"
    />
  );
}