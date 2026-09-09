import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import { SECTION_COLLAPSE_DURATION_MS } from '../SectionCollapse';

/**
 * 「最多 N 条 + 显示全部」列表的 showAll 状态,段落收起后自动复位。
 *
 * SectionCollapse 收起动画期间内容仍挂载,showAll 不会立刻随卸载归零,这里在
 * 收起后主动复位;复位延后到 200ms 收起动画结束后执行,避免动画过程中列表数量
 * 先缩短再收起造成视觉跳变。sectionCollapsed 只能传项目 / 段落自身的折叠态,
 * 不要传 Sidebar peek / pinning 这类外壳状态;浮层预览和固定展开切换必须保留
 * 列表内部状态。
 */
export function useCollapsibleShowAll(
  sectionCollapsed: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!sectionCollapsed || !showAll) return;

    const timeoutId = window.setTimeout(() => {
      setShowAll(false);
    }, SECTION_COLLAPSE_DURATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [sectionCollapsed, showAll]);

  return [showAll, setShowAll];
}
