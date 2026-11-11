/**
 * CollapsibleSubSection —— 「远程连接」页的可折叠子块(标题 + 收起态摘要 + 常驻内容 + 折叠区)。
 * 收起只做 CSS 隐藏、内容保持挂载:子组件的数据订阅与内联编辑状态不因折叠丢失。
 * 旧版列表页与新版拓扑页共用。
 */

import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SETTINGS_SECTION_TITLE_CLASS } from '@/components/ui/settings-rows';

export function CollapsibleSubSection({
  id,
  title,
  summary,
  dotColor,
  open,
  onToggle,
  pinned,
  children,
}: {
  id?: string;
  title: string;
  /** 收起态 header 右侧的状态摘要;null = 数据未就绪,整块不显示(避免闪一帧错误状态)。 */
  summary: string | null;
  dotColor: string | null;
  open: boolean;
  onToggle: () => void;
  /** 不随折叠隐藏的常驻内容(如「我的设备」的本机卡),渲染在 header 与折叠区之间。 */
  pinned?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex flex-col gap-3">
      <button
        data-settings-search-action="Expand or collapse the remote-control section"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-center justify-between gap-3 text-left"
      >
        <span className={`shrink-0 ${SETTINGS_SECTION_TITLE_CLASS}`}>{title}</span>
        <div className="flex min-w-0 items-center gap-2">
          {!open && summary ? (
            <>
              {dotColor ? (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                  aria-hidden
                />
              ) : null}
              <span className="truncate text-12 text-[var(--text-tertiary)]">{summary}</span>
            </>
          ) : null}
          <span
            className="shrink-0 text-[var(--text-tertiary)] transition-colors group-hover:text-[var(--text-primary)]"
            aria-hidden
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </div>
      </button>
      {pinned}
      <div hidden={!open}>{children}</div>
    </section>
  );
}
