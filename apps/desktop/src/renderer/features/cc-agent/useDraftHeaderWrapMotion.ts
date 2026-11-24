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
      height: chips.offsetHeight,
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
        height: from.height,
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
      // 按钮排自身的内折行会让它变高（窄一下就从一行变两行）。FLIP 只搬位置不搬尺寸：
      // 输入区若还从旧位置开始，前一段会压在高出来的那部分按钮排下面。把这段高度差
      // 加进起点，等于让它直接落到新布局；高度没变时是 0，行为不变。
      const grown = Math.max(0, chips.offsetHeight - start.height);
      const dContent = start.contentTop + grown - content.offsetTop;
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
        // 折行与复原都走「先沿当前列上下、再沿目标行左右」两条腿:直接对角线插值会让
        // 按钮排从 logo 右上角穿到 logo 左下角,200ms 里又压一次 logo。第一腿停在
        // logo 右侧(折行)或 logo 下方(复原),第二腿才横移,两段都不经过品牌区。
        const corner = stacked ? `translate(${dx}px, 0)` : `translate(0, ${dy}px)`;
        animations.push(
          chips.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: corner, offset: 0.5 },
              { transform: 'none' },
            ],
            { duration, easing },
          ),
        );
      }
      if (Math.abs(dContent) >= 0.5) {
        // 输入区用 margin 平移,不用 transform:transform 会让输入框内的浮层锚点在动画
        // 期间暂时跟丢;两种写法结束时都回到静态值,不留定位上下文。
        // 与按钮排同一条折线:输入区只在纵向那一腿跟着走,横移阶段不动,否则中段会追到
        // 按钮排底下(按钮排已经在新一行,输入区还差一截)。
        animations.push(
          content.animate(
            [
              { marginTop: `${baseMargin + dContent}px` },
              { marginTop: `${baseMargin + (stacked ? 0 : dContent)}px`, offset: 0.5 },
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
    // The button row can change without the brand row changing: a project, device or
    // branch chip appears, widens or shrinks while the row stays on one line. Observe it
    // too, so the FLIP start is the position the owner actually sees before the wrap.
    observer.observe(row);
    observer.observe(chips);
    return () => {
      observer.disconnect();
      for (const animation of animations) animation.cancel();
    };
  }, [rowRef, chipsRef, contentRef, logoHeight]);
}
