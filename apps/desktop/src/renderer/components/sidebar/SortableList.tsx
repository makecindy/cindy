/**
 * SortableList — 基于 SortableJS 的薄包装
 * ---------------------------------------------------------------------------
 * 用于侧栏内 Project / Pinned 等需要"流畅拖拽 + 让位动画 + 跟手悬浮卡"的列表场景。
 * 视觉对标 Codex 桌面端 sidebar：整行可拖、占位 ghost、悬浮 dragClass。
 *
 * 设计要点
 *   1. SortableJS 直接操作 DOM；React 同时 own children DOM。两者在 drop 时会
 *      争夺所有权 —— 经典做法是在 `onEnd` 里 **把被拖元素 DOM 回滚到原位置**，
 *      然后把"新顺序的 id 列表"上抛给调用方，让 React 作为唯一 DOM writer
 *      在下一次 render 时按新顺序重建。这样 React 内部 child reconciliation 不会
 *      因为 DOM 节点位置被 Sortable 偷偷换了而困惑。
 *      参考：https://github.com/SortableJS/Sortable/issues/1244 (官方推荐)
 *
 *   2. items 数组在 props 变化时由 React 接管 children 顺序；Sortable 实例
 *      只在 mount 时挂一次，配置变化通过 `option(name, value)` 增量更新，避免
 *      重复 destroy/init 抖掉用户当前的拖拽手势。
 *
 *   3. reducedMotion=true 时 animation: 0，否则 150ms（SortableJS 默认）。
 *
 *   4. 视觉 class（在 sortable.css 内定义）：
 *      - `xdt-sortable-ghost`  → sidebar 原位置的虚位 placeholder, opacity:0.3
 *         的整体淡出, 表达"这块正在被搬走"。由 SortableJS 在 _onDragStart 自动加,
 *         _onDrop 自动撤, 生命周期天然对齐"实际拖拽中"。
 *      - `xdt-sortable-drag`   → 跟手悬浮的克隆样式: full opacity + 原始尺寸 + 柔和
 *         阴影 → 看起来就是"正常侧边栏内容浮起来", 不放大不淡出。
 *      ⚠️ `chosenClass` 故意传空串禁用 SortableJS 的默认行为: 默认它会在
 *      pointerdown 就把 chosen 贴到 row wrapper, 而 row wrapper 装的是整个
 *      ProjectNode, 会让"按一下任意 session 整组就亮", 这是肉眼可见的 bug。
 *      "拖动时原位置淡出"的视觉走 ghostClass 完成 (ghost 是 _onDragStart 才触发,
 *      跟 fallbackTolerance:4 联动, 真正开拖才上 class)。
 *
 *   5. 强制走 SortableJS 的 fallback 模式（`forceFallback: true`）：
 *      默认 HTML5 Drag and Drop 在 React 19 + 频繁 re-render + 嵌套 click /
 *      contextmenu handler（如 SessionItem）的环境下行为不稳，常出现"按下完全
 *      不响应"或"拖一下又被 React 重新挂载吃掉"。fallback 模式用纯 JS pointer
 *      events 模拟拖拽，跨浏览器 / 嵌套交互更可预测。配套：
 *        - `fallbackOnBody: true`     → 拖拽 clone 挂到 body 上，不会被父容器
 *           overflow / transform 裁切
 *        - `fallbackTolerance: 4`     → 鼠标移动超过 4px 才进入拖拽态，避免把
 *           点击 / 双击 SessionItem 误判成微拖
 *
 *   6. 窗口失焦时强制释放拖拽：fallback 模式只监听 document 上的 pointerup /
 *      mouseup / touchend / pointercancel；用户 Alt-Tab 切走、点 Electron 窗口
 *      外、按 Win/⌘ 调出系统 UI 时这些事件都不会触发，drag 会卡在"ghost 还粘在
 *      鼠标 + chosen class 还挂在原行 + Sortable.active 还非空"的状态。
 *      解法：监听 window 的 `blur` 和 document 的 `visibilitychange`，发现窗口
 *      失焦且当前有 active 拖拽就 dispatch 一个合成 pointercancel 到 document，
 *      触发 SortableJS 自己的 _onDrop 清理流程；同时用一个 ref 标记"这次 onEnd
 *      是被动取消的"，跳过 reorder 提交，避免用户切窗口的瞬间被记下一次未授意
 *      的顺序变化。
 *
 *   7. 拖拽光标只在"真正拖动中"出现：行本身常态保持各自语义光标（如 ProjectNode
 *      整行点击 = 折叠，用 pointer），不在 hover 时就显示 grab —— 否则"鼠标移上去
 *      就像随时在拖动"。真正开拖时(onStart, 移动超过 fallbackTolerance 才触发)给
 *      <body> 挂 `xdt-sorting`，由 sortable.css 全局把光标切成 grabbing；onEnd /
 *      失焦兜底 / 卸载时摘掉。为什么必须 body 级而不是给浮卡设 cursor：fallback
 *      模式浮起的 clone 是 pointer-events:none，光标实际由其下方元素决定，给 clone
 *      设 cursor 不生效，只有 body 级全局规则能覆盖整个拖拽过程。
 */

import { useEffect, useMemo, useRef, type AriaRole, type ReactNode } from 'react';
import Sortable, { type SortableEvent } from 'sortablejs';

export interface SortableListProps<T> {
  /** 列表项数据（按当前希望渲染的顺序传入）。 */
  items: readonly T[];
  /** 提取稳定 id，用于 data-sortable-id + onReorder 上报。 */
  getId: (item: T) => string;
  /** 拖拽落定后回调，参数是按新顺序排好的 id 列表（包含 items 中所有元素）。 */
  onReorder: (newOrderIds: string[]) => void;
  /** 渲染单项。SortableList 会用一个 div 包一层挂 data-sortable-id；
   *  你的 renderItem 输出可以是任意 ReactNode（按钮、嵌套结构等）。 */
  renderItem: (item: T, index: number) => ReactNode;
  /** 禁用拖拽（例如 sortBy !== 'manual' 时）。 */
  disabled?: boolean;
  /** 系统 "Reduce motion" 偏好；true 时关掉 SortableJS 自带的过渡动画。 */
  reducedMotion?: boolean;
  /** 可选 CSS selector 指定拖拽手柄；不传则整行可拖。 */
  handle?: string;
  /** 拖拽真正开始 / 结束时通知调用方；用于暂停列表外部的自动副作用。 */
  onDragActiveChange?: (active: boolean) => void;
  /** 可选 CSS selector：匹配的元素不参与拖拽起手势（按钮、输入框等）。
   *  默认 `'button, input, textarea, select, a, [data-no-drag]'`，覆盖
   *  绝大多数会"误把可交互元素当成拖动起点"的场景。 */
  filter?: string;
  /** 是否强制使用 SortableJS 的 pointer fallback。关闭后使用原生 DnD，
   *  允许同一个会话行把拖拽交给右侧分屏 drop target。 */
  forceFallback?: boolean;
  /** 容器额外 class（如 flex-col / gap 等布局）。 */
  className?: string;
  /** 每个 Sortable wrapper 的额外 class，用于非侧栏场景覆盖 drag/ghost 视觉。 */
  rowClassName?: string;
  /** 可选 ARIA role，便于把 SortableList 用在真正的 list 语义里。 */
  role?: AriaRole;
  /** 可选 ARIA label，配合 role 使用。 */
  ariaLabel?: string;
}

const DEFAULT_FILTER = 'button, input, textarea, select, a, [data-no-drag]';

// 拖拽进行中挂到 <body> 的标记 class —— sortable.css 据此把光标全局切成 grabbing。
// 见文件顶部"设计要点 7"：fallback 模式的浮起 clone 是 pointer-events:none，
// 光标由其下方元素决定，只有 body 级全局规则才能覆盖整个拖拽过程。
const SORTING_BODY_CLASS = 'xdt-sorting';

export function SortableList<T>({
  items,
  getId,
  onReorder,
  renderItem,
  disabled = false,
  reducedMotion = false,
  handle,
  onDragActiveChange,
  filter,
  forceFallback = true,
  className,
  rowClassName,
  role,
  ariaLabel,
}: SortableListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sortableRef = useRef<Sortable | null>(null);

  // 用 ref 装最新的 items / getId / onReorder，避免 onEnd 闭包拿到旧值
  // （Sortable 实例只在 mount 时挂一次，options 增量更新；不能让 callback 凝固）。
  const itemsRef = useRef(items);
  const getIdRef = useRef(getId);
  const onReorderRef = useRef(onReorder);
  const onDragActiveChangeRef = useRef(onDragActiveChange);
  itemsRef.current = items;
  getIdRef.current = getId;
  onReorderRef.current = onReorder;
  onDragActiveChangeRef.current = onDragActiveChange;

  // 标记下一次 onEnd 是"窗口失焦兜底"触发的——onEnd 里把 DOM 复位后直接 return,
  // 不调 onReorder, 避免用户切走窗口的瞬间被记下一次未授意的顺序变化。
  const abortNextEndRef = useRef(false);
  // Native DnD must only persist a reorder when the final drop lands in this
  // sortable container. Drops on the composer, split panes, or outside Cindy
  // can still leave Sortable's DOM temporarily moved while the gesture passes.
  const nativeDropDispositionRef = useRef<'internal' | 'external' | null>(null);

  // mount 时创建 Sortable；unmount 时销毁。后续 props 变化通过 option() 更新。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const instance = Sortable.create(el, {
      animation: reducedMotion ? 0 : 150,
      disabled,
      handle,
      filter: filter ?? DEFAULT_FILTER,
      // preventOnFilter=true 会把 filter 命中的元素的原生事件 preventDefault 掉，
      // 导致按钮/输入框无法点击。这里必须设 false，让按钮该响应响应。
      preventOnFilter: false,
      ghostClass: 'xdt-sortable-ghost',
      // 空串 → SortableJS 的 toggleClass 内部 if(name) 短路, pointerdown 不再
      // 自动加 chosen 背景。"拖动时原位置淡出"的视觉走 ghostClass (开拖才触发),
      // 不需要 chosenClass。见文件顶部"设计要点 4"。
      chosenClass: '',
      dragClass: 'xdt-sortable-drag',
      // 见文件顶部"设计要点 5"：强制 JS fallback，绕开 HTML5 DnD 在 React 19 +
      // 嵌套 click/contextmenu 环境下的不稳定行为。
      forceFallback,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      setData: (dataTransfer, dragEl) => {
        // Keep the browser-required plain-text slot empty: DOM text can contain
        // task titles/previews and would leak if the drag leaves the app.
        dataTransfer.setData('Text', '');
        const rect = dragEl.getBoundingClientRect();
        dataTransfer.setDragImage(
          dragEl,
          Math.min(24, Math.max(0, rect.width / 2)),
          Math.min(24, Math.max(0, rect.height / 2)),
        );
      },
      // 真正开拖（移动超过 fallbackTolerance）才触发,不是 pointerdown 即触发——
      // 所以"按下未拖"和"普通 hover"都不会上 grabbing 光标,只有真正拖动中才会。
      onStart: () => {
        nativeDropDispositionRef.current = null;
        document.body.classList.add(SORTING_BODY_CLASS);
        onDragActiveChangeRef.current?.(true);
      },
      onEnd: (evt: SortableEvent) => {
        // 正常 drop 和失焦兜底(dispatch pointercancel → _onDrop → onEnd)都会走到
        // 这里,统一在入口摘掉全局 grabbing 标记。
        document.body.classList.remove(SORTING_BODY_CLASS);
        onDragActiveChangeRef.current?.(false);

        const aborted = abortNextEndRef.current;
        abortNextEndRef.current = false;
        const dropDisposition = nativeDropDispositionRef.current;
        nativeDropDispositionRef.current = null;

        const oldIndex = evt.oldIndex;
        const newIndex = evt.newIndex;

        // 关键步骤：把 SortableJS 在 DOM 上做的"移动"撤销，恢复成 mount 时
        // React 期望的 DOM 顺序。下一次 render 由 React 按 `newOrderIds`
        // 重新铺 DOM，避免 React reconciler 与 SortableJS 同时改 DOM 打架。
        // 失焦兜底路径也要走这一步，否则 ghost 位置上的 item 会留在被 hover
        // 让位时的位置上。
        const parent = evt.from;
        if (parent && evt.item && oldIndex != null) {
          evt.item.parentNode?.removeChild(evt.item);
          const refNode = parent.children[oldIndex] ?? null;
          parent.insertBefore(evt.item, refNode);
        }

        if (aborted || (!forceFallback && dropDisposition !== 'internal')) return;
        if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;

        const currentItems = itemsRef.current;
        const idOf = getIdRef.current;
        if (oldIndex >= currentItems.length || newIndex >= currentItems.length) return;

        const nextIds = currentItems.map((it) => idOf(it));
        const [moved] = nextIds.splice(oldIndex, 1);
        if (moved == null) return;
        nextIds.splice(newIndex, 0, moved);
        onReorderRef.current(nextIds);
      },
    });
    sortableRef.current = instance;

    // Native Sortable receives the document `drop` event after capture. Record
    // whether the final target is internal or external before onEnd restores
    // the transient DOM move.
    const markDropDisposition = (event: Event) => {
      if (Sortable.active !== instance) return;
      const target = event.target;
      nativeDropDispositionRef.current =
        target instanceof Node && el.contains(target) ? 'internal' : 'external';
    };
    document.addEventListener('drop', markDropDisposition, true);

    // 窗口失焦兜底：用户 Alt-Tab / 点窗口外 / 调出系统 UI 时，document 上的
    // pointerup/mouseup/touchend 都不会触发，SortableJS 的 fallback 拖拽会卡住。
    // 这里发现自家实例正在拖时，dispatch 一个合成 pointercancel(它在 fallback
    // 模式下被注册为 _onDrop 的 trigger 之一)，让 SortableJS 自己跑完清理流程。
    // 标记 abortNextEndRef 让上面的 onEnd 跳过 reorder 提交。
    const abortIfActive = () => {
      if (Sortable.active !== instance) return;
      abortNextEndRef.current = true;
      try {
        document.dispatchEvent(new Event('pointercancel'));
      } catch {
        // 极少数老环境构造 Event 失败时退回到 mouseup（同样被 fallback 监听）
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') abortIfActive();
    };
    window.addEventListener('blur', abortIfActive);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('blur', abortIfActive);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('drop', markDropDisposition, true);
      // 拖动中组件被卸载时兜底清掉标记,避免 grabbing 光标残留到全局。
      document.body.classList.remove(SORTING_BODY_CLASS);
      onDragActiveChangeRef.current?.(false);
      instance.destroy();
      sortableRef.current = null;
    };
    // 故意只在 mount 时建一次实例；后续 props 变化通过下面的 effect 增量同步。
    // （deps 故意留空，所有 callback 走 ref 转发避免捕获旧 closure。）
  }, []);

  // disabled / animation / handle / filter 变化时增量同步到现有 Sortable 实例
  useEffect(() => {
    const sortable = sortableRef.current;
    if (!sortable) return;
    sortable.option('disabled', disabled);
    sortable.option('animation', reducedMotion ? 0 : 150);
    // handle 是 selector 字符串，undefined 表示整行可拖
    sortable.option('handle', handle ?? '');
    sortable.option('filter', filter ?? DEFAULT_FILTER);
  }, [disabled, reducedMotion, handle, filter]);

  // children 由 React 控制，直接按 items 顺序渲染。
  const children = useMemo(
    () =>
      items.map((item, index) => {
        const id = getId(item);
        return (
          <div
            key={id}
            data-sortable-id={id}
            className={rowClassName ? `xdt-sortable-row ${rowClassName}` : 'xdt-sortable-row'}
          >
            {renderItem(item, index)}
          </div>
        );
      }),
    [items, getId, renderItem, rowClassName],
  );

  return (
    <div
      ref={containerRef}
      data-sortable-native-dnd={forceFallback ? undefined : 'true'}
      role={role}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </div>
  );
}
