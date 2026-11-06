/**
 * 侧栏列表模式一行的共用外观:任务列表模式(SessionCard variant="list")与伙伴段展开行
 * 同高、同一套选中样式,两边引用这里,改任务行几何或选中态时一起改。
 *
 * 高度:上下内边距 8 + 8、标题槽 22、间距 4、1 行预览(text-xs × 1.45)。
 * 默认字号约 59px,随界面字号缩放。
 */
export const SIDEBAR_LIST_ROW_HEIGHT_CLASS = 'h-[calc(42px+1.45*var(--text-xs))]';

/**
 * 选中:实色底 + 1px 内描边。描边用 inset shadow 而非真实 border,不参与布局,
 * 选中 / 取消时行高逐像素不变。
 */
export const SIDEBAR_LIST_ROW_ACTIVE_CLASS =
  'bg-sidebar-item-active text-sidebar-item-active-foreground shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)]';
