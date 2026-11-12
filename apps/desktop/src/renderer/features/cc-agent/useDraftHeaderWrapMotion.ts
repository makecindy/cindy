import { useLayoutEffect, type RefObject } from 'react';

/**
 * 新建页品牌行的折行动画。
 *
 * 换行点由 CSS 决定:logo 与按钮排是同一条 flex-wrap 行上的两项,按钮排装不下就整排
 * 折到 logo 下方(左边缘与 logo 对齐),所以只要放不下就换,不必等按钮盖住 logo。
 *
 * 换行是瞬时的布局跳变,这里用 FLIP 补成滑动:按钮排从上一处位置滑到新位置,输入区
 * 跟着收放,否则宽窄切换时整块内容会硬跳。
 */
export function useDraftHeaderWrapMotion(
  rowRef: RefObject<HTMLElement | null>,
  chipsRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  logoHeight: number,
): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    const chips = chipsRef.current;
    const content = contentRef.current;
    if (!row || !chips || !content) return;
    // 输入区的静态上边距;动画只是在它之上加减折行带来的位移。
    const baseMargin = parseFloat(getComputedStyle(content).marginTop) || 0;
    // 上一次稳定布局的几何。offsetTop/offsetLeft 只反映布局、不含动画值,动画进行中
    // 再读也不会读到自己滑动的中间位置。
    const read = () => ({
      left: chips.offsetLeft,
      top: chips.offsetTop,
      contentTop: content.offsetTop,
    });
    let from = read();
    // 按下的折行动画还没播完就反向折行时,起点要接住屏幕上正在看的位置:上一段动画
    // 的当前偏移量 + 折行前的布局位置。
    const shifted = () => {
      const style = getComputedStyle(chips);
      const matrix = style.transform === 'none' ? null : new DOMMatrixReadOnly(style.transform);
      const margin = parseFloat(getComputedStyle(content).marginTop) || 0;
      return {
        left: from.left + (matrix?.m41 ?? 0),
        top: from.top + (matrix?.m42 ?? 0),
        contentTop: from.contentTop + margin - baseMargin,
      };
    };
    // 按钮排落到 logo 底边以下 = 已折行。
    let stacked = chips.offsetTop >= logoHeight;
    let animations: Animation[] = [];
    const observer = new ResizeObserver(() => {
      const next = chips.offsetTop >= logoHeight;
      if (next === stacked) {
        // 动画进行中量到的是中间值,等它收尾再记录基线。
        if (animations.length === 0) from = read();
        return;
      }
      const start = animations.length > 0 ? shifted() : from;
      stacked = next;
      // 先把上一段动画停下再量:margin 动画进行中量到的 contentTop 带着动画值。
      for (const animation of animations) animation.cancel();
      animations = [];
      from = read();
      const style = getComputedStyle(chips);
      const token = style.getPropertyValue('--motion-base').trim();
      const duration = (parseFloat(token) || 0) * (token.endsWith('ms') ? 1 : 1000);
      if (!duration || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const easing = style.getPropertyValue('--motion-ease-move').trim() || 'linear';
      const dx = start.left - chips.offsetLeft;
      const dy = start.top - chips.offsetTop;
      const dContent = start.contentTop - content.offsetTop;
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
        animations.push(
          chips.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
            duration,
            easing,
          }),
        );
      }
      if (Math.abs(dContent) >= 0.5) {
        // 输入区用 margin 平移,不用 transform:transform 会让输入框内的浮层锚点在动画
        // 期间暂时跟丢;两种写法结束时都回到静态值,不留定位上下文。
        animations.push(
          content.animate(
            [
              { marginTop: `${baseMargin + dContent}px` },
              { marginTop: `${baseMargin}px` },
            ],
            { duration, easing },
          ),
        );
      }
      const running = animations;
      void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
        if (animations !== running) return; // 已被下一次折行接管。
        animations = [];
        from = read();
      });
    });
    observer.observe(row);
    return () => {
      observer.disconnect();
      for (const animation of animations) animation.cancel();
    };
  }, [rowRef, chipsRef, contentRef, logoHeight]);
}
