/**
 * CardMasonry — 置顶卡片的响应式分栏容器
 * ---------------------------------------------------------------------------
 * 宽度自适应(用户需求:常规业务宽度下就该是两列,列窄一点没关系):
 *   - < 246px  → 单列满宽 = redesign 稿原貌(默认窄侧栏形态)
 *   - ≥ 246px  → 2 列 CSS columns 瀑布流(列宽 ~120px 起)
 *   - ≥ 390px  → 3 列(useSidebarResize MAX_WIDTH=480,拖到最宽 3 列)
 * 容器宽 = 侧栏宽 - 左右内边距 22 - scrollbar-gutter 12;换算成侧栏宽:
 * ~258px 进 2 列、~424px 进 3 列。
 *
 * 246 的由来:摘要长档硬上限 26 字(sessionTaskSummary.ts),3 行 clamp 下
 * 需要 ≥9 字/行;预览宽 = 列宽 - 卡片 px-10,11px 字号下 9 字 = 99px,
 * 即列宽 ≥119.5 → 容器 ≥246。230 时预览仅 ~96px(8 字/行),纯中文 26 字
 * 会溢出到第 4 行被裁(离屏逐档实测)。
 *
 * 布局:单列 → SortableList(flex-col);多列 → DraggableCardColumns 错落瀑布。
 * 卡片随内容变高(摘要 line-clamp 1~3 行:活跃/长任务更高、旧任务缩到最小),各列独立
 * 堆叠成错落,不强制等高。纵向间距 gap-[7px]。
 *
 * 拖拽:单列走 SortableList;多列走 DraggableCardColumns(每列一个 SortableJS 实例 +
 * 跨列 group,轮转双射回写同一份 1 维 manualPinnedOrder)。两条路都整卡可拖。
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { SortableList } from '@/components/sidebar/SortableList';
import { DraggableCardColumns } from './DraggableCardColumns';

/** 2 列最小容器宽度(px)——低于此宽度永远单列(redesign 稿默认形态)。
 *  下限由摘要长档 26 字 ÷ 3 行 = 9 字/行反推(见文件头注释)。 */
const TWO_COL_MIN_WIDTH = 246;
/** 3 列最小容器宽度(px)——须低于侧栏拖拽上限(480)扣除左右内边距与
 *  scrollbar-gutter(12px)后可达(480-22-12=446)。 */
const THREE_COL_MIN_WIDTH = 390;

export interface CardMasonryProps<T> {
  items: T[];
  getId: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** 拖拽落定写回的新 1 维顺序;与列表 / rail 同一份 manualPinnedOrder 契约。 */
  onReorder: (newOrderIds: string[]) => void;
  reducedMotion: boolean;
  /** SortableJS 跨列拖拽的 group 名;默认 'pinned-cards'。 */
  groupId?: string;
  /** 与 SortableList 同口径；置顶卡片用原生 DnD 兼容分屏 drop。 */
  forceFallback?: boolean;
}

export function CardMasonry<T>({
  items,
  getId,
  renderItem,
  onReorder,
  reducedMotion,
  groupId,
  forceFallback = true,
}: CardMasonryProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      setColumns(width >= THREE_COL_MIN_WIDTH ? 3 : width >= TWO_COL_MIN_WIDTH ? 2 : 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="w-full">
      {/* 列数变化时 key 变 → 内层重挂 → card-col-fade 淡入,软化列数切换的"硬跳"
          (对照 rail 收起的渐隐)。外层 ref 容器保持稳定,ResizeObserver 不受影响;
          reducedMotion 时不挂动画类(瞬时)。 */}
      <div key={columns} className={reducedMotion ? undefined : 'card-col-fade'}>
        {columns === 1 ? (
          <SortableList
            items={items}
            getId={getId}
            onReorder={onReorder}
            reducedMotion={reducedMotion}
            forceFallback={forceFallback}
            className="flex flex-col gap-[7px]"
            renderItem={renderItem}
          />
        ) : (
          <DraggableCardColumns
            items={items}
            columns={columns}
            getId={getId}
            renderItem={renderItem}
            onReorder={onReorder}
            reducedMotion={reducedMotion}
            groupId={groupId}
            forceFallback={forceFallback}
          />
        )}
      </div>
    </div>
  );
}
