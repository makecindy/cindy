/**
 * EmptyState — 右侧栏一个 tab 都没打开时的占位(对应设计稿 F1 · v2 Welcome 风)。
 *
 * 视觉骨架:左对齐 · 顶部 padding · eyebrow / 标题 / 描述 / 动作列表 / 底部 + 提示。
 * 行右侧用 chevron 而非快捷键(快捷键在代码里没绑定,画 kbd 会骗用户)。
 * 严格走 token(规则 16),不写 hex。
 *
 * 插件面板不再出现在这里(面板收束,2026-08):页签形态的插件面板由
 * 插件页独占承载,入口只在 /plugins。
 */

import {
  Activity,
  ChevronRight,
  FileDiff,
  FolderOpen,
  Globe,
  ListTodo,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  onAddFileTab: () => void;
  onAddBrowserTab: () => void;
  onAddTerminalTab: () => void;
  onAddReviewTab: () => void;
  onAddBackgroundTasksTab: () => void;
  onAddResourceUsageTab: () => void;
}

export function EmptyState({
  onAddFileTab,
  onAddBrowserTab,
  onAddTerminalTab,
  onAddReviewTab,
  onAddBackgroundTasksTab,
  onAddResourceUsageTab,
}: EmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-start gap-8 overflow-y-auto px-10 pb-8 pt-16">
      <div className="flex w-full flex-col gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {t('rightSidebar.tabs.empty.eyebrow')}
        </span>
        <span className="text-[22px] font-semibold leading-tight text-[var(--text-primary)]">
          {t('rightSidebar.tabs.empty.title')}
        </span>
        <span className="text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          {t('rightSidebar.tabs.empty.desc')}
        </span>
      </div>
      <div className="flex w-full flex-col">
        <ActionRow
          icon={FolderOpen}
          label={t('rightSidebar.tabs.empty.openFile')}
          sub={t('rightSidebar.tabs.empty.fileSub')}
          onClick={onAddFileTab}
        />
        {/* 审查项:tabs 列表为空时(用户从未开过或手动关掉过 review tab),这里是
            用户重开 review tab 的入口。放在文件浏览器下面,顺序与 + dropdown 保持
            一致(file-browser order=10 → review order=15 → browser order=20)。 */}
        <ActionRow
          icon={FileDiff}
          label={t('rightSidebar.tabs.empty.openReview')}
          sub={t('rightSidebar.tabs.empty.reviewSub')}
          onClick={onAddReviewTab}
        />
        {/* 后台任务:顺序与 + dropdown 一致(review order=15 → background-tasks
            order=17 → browser order=20)。 */}
        <ActionRow
          icon={ListTodo}
          label={t('rightSidebar.tabs.empty.openBackgroundTasks')}
          sub={t('rightSidebar.tabs.empty.backgroundTasksSub')}
          onClick={onAddBackgroundTasksTab}
        />
        {/* 资源用量 order=18，紧跟 background-tasks=17，顺序与 + 菜单一致。 */}
        <ActionRow
          icon={Activity}
          label={t('rightSidebar.tabs.empty.openResourceUsage')}
          sub={t('rightSidebar.tabs.kinds.resourceUsage')}
          onClick={onAddResourceUsageTab}
        />
        <ActionRow
          icon={Globe}
          label={t('rightSidebar.tabs.empty.openBrowser')}
          sub={t('rightSidebar.tabs.empty.browserSub')}
          onClick={onAddBrowserTab}
        />
        <ActionRow
          icon={Terminal}
          label={t('rightSidebar.tabs.empty.openTerminal')}
          sub={t('rightSidebar.tabs.empty.terminalSub')}
          onClick={onAddTerminalTab}
        />
      </div>
      <p className="px-1 text-[11px] text-[var(--text-tertiary)]">
        {t('rightSidebar.tabs.empty.addMoreHint')}
      </p>
    </div>
  );
}

function ActionRow({
  icon: Icon,
  label,
  sub,
  onClick,
  inset = false,
}: {
  icon: LucideIcon;
  label: string;
  sub: string;
  onClick: () => void;
  /** 折叠分组的子行:左侧缩进一档,视觉上归属上方 expander。 */
  inset?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-3.5 border-b border-[var(--border-default)] px-1 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]',
        inset && 'pl-9',
      )}
    >
      <Icon size={16} className="text-[var(--text-secondary)]" />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium text-[var(--text-primary)]">{label}</span>
        <span className="text-[11px] text-[var(--text-tertiary)]">{sub}</span>
      </span>
      <ChevronRight
        size={14}
        className="text-[var(--text-tertiary)] transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
