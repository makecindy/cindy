/**
 * FilterReminderDot —— 筛选提醒点(DESIGN.md「筛选提醒点」,2026-10-20 登记)。
 * 6px 强调色小圆点,落在筛选 / 视图设置按钮的右上角,提醒「当前列表不是默认的进行中视图」:
 * 搜索框旁的筛选按钮有筛选条件生效时、整理侧边栏按钮在查看「已归档」时都用它,
 * 位置 / 大小 / 颜色只此一处,不要在调用方另写一份。
 * inline 用于菜单内对应的设置项。纯装饰:状态由按钮或菜单行的名称 / 当前值播报。
 * 默认角标的宿主按钮须带 `relative`。
 */
export function FilterReminderDot({ inline = false }: { inline?: boolean }) {
  return (
    <span
      aria-hidden
      data-filter-reminder=""
      className={`pointer-events-none size-1.5 shrink-0 rounded-full bg-[var(--status-bar-accent)] ${inline ? '' : 'absolute right-0.5 top-0.5'}`}
    />
  );
}
