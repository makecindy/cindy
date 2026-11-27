/**
 * FilterReminderDot —— 筛选提醒点(DESIGN.md「筛选提醒点」,2026-10-20 登记)。
 * 6px 强调色小圆点,落在筛选 / 视图设置按钮的右上角,提醒「当前列表被收窄了」:
 * 搜索框旁的筛选按钮有筛选条件生效时、侧边栏显示设置按钮在收件箱里有筛选或隐藏生效时都用它。
 * 查看「已归档」任务不再标点(2026-11-28 用户决定,桌面端)。
 * 位置 / 大小 / 颜色只此一处,不要在调用方另写一份。纯装饰:状态由按钮的名称 / 当前值播报。
 * 宿主按钮须带 `relative`。
 */
export function FilterReminderDot() {
  return (
    <span
      aria-hidden
      data-filter-reminder=""
      className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 shrink-0 rounded-full bg-[var(--status-bar-accent)]"
    />
  );
}
