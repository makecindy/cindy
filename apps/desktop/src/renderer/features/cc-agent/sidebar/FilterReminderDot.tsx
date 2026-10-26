/**
 * FilterReminderDot —— 筛选提醒点(DESIGN.md「筛选提醒点」,2026-10-20 登记)。
 * 6px 强调色小圆点,落在筛选 / 视图设置按钮的右上角,提醒「当前列表不是默认的进行中视图」:
 * 搜索框旁的筛选按钮有筛选条件生效时、整理侧边栏按钮在查看「已归档」时都用它,
 * 位置 / 大小 / 颜色只此一处,不要在调用方另写一份。
 * 纯装饰:状态由按钮的 aria-label 播报。宿主按钮须带 `relative`。
 */
export function FilterReminderDot() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-[var(--status-bar-accent)]"
    />
  );
}
