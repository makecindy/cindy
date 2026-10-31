/**
 * 卡片在线指示 —— 插件给 span / div 标 `data-ghost-live`,宿主给它播统一的呼吸光环。
 *
 * 插件卡片在调用结束后只保留静态版(规则 7:历史卡不常驻动画),而「跟进中」这类状态
 * 会持续好几天。光环由宿主驱动,只用 transform + opacity:卡片滚出视口时暂停,窗口隐藏时
 * 由 hiddenAnimationGate 冻结(infinite 动画),系统开了减弱动效则不播。
 */
import { alignFrameWithGate, HIDDEN_ANIMATION_ATTR } from '@/lib/hiddenAnimationGate';

const LIVE_SELECTOR = '[data-ghost-live]';
const PULSE_MS = 1800;

/** 给文档里的在线指示挂光环;返回清理函数。没有标记时什么都不做。 */
export function startGhostCardLiveIndicators(
  doc: Document,
  frame: HTMLIFrameElement,
  reducedMotion: () => boolean = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
): () => void {
  const targets = Array.from(doc.querySelectorAll<HTMLElement>(LIVE_SELECTOR));
  if (!targets.length || reducedMotion()) return () => {};
  const animations = targets.map((el) =>
    el.animate(
      [
        { transform: 'scale(1)', opacity: 0.55 },
        { transform: 'scale(2.6)', opacity: 0 },
      ],
      { duration: PULSE_MS, iterations: Infinity, easing: 'cubic-bezier(0, 0, 0.2, 1)' },
    ),
  );
  // 窗口可能已隐藏:交给闸门统一登记,恢复时才会一起 play。
  const hostDoc = frame.ownerDocument;
  if (hostDoc?.defaultView) alignFrameWithGate(doc, hostDoc, hostDoc.defaultView);
  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      for (const animation of animations) {
        // 窗口隐藏期间由闸门冻结,滚回视口也不抢着恢复。
        const hidden = hostDoc?.documentElement?.hasAttribute(HIDDEN_ANIMATION_ATTR) === true;
        if (visible && !hidden && animation.playState === 'paused') animation.play();
        else if (!visible && animation.playState === 'running') animation.pause();
      }
    });
    observer.observe(frame);
  }
  return () => {
    observer?.disconnect();
    for (const animation of animations) animation.cancel();
  };
}
