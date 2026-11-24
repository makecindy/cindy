import { useState } from 'react';
import { ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AttentionDot } from './AttentionDot';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { claimTaskInboxIntro, TaskInboxIntro } from '@/features/cc-agent/sidebar/TaskInboxIntro';
import { useTaskListMode } from '@/hooks/useTaskListMode';
import { cn } from '@/lib/utils';

/**
 * 收件箱开关：侧边栏顶部 chrome 行（前进 / 后退这一排）的最右端，只在任务列表视图出现
 * （2026-11-18 用户决定）。与相邻 chrome 按钮同规格；开启时带选中底色并标记 aria-pressed。
 * 这台电脑第一次开启时弹出收件箱介绍。
 */
export function TaskListModeToggle({ hasUnread }: { hasUnread: boolean }) {
  const { t } = useTranslation();
  const { mode, setMode } = useTaskListMode();
  const [intro, setIntro] = useState(false);
  const inbox = mode === 'inbox';
  const showUnread = !inbox && hasUnread;
  const label = t(inbox ? 'ccAgent.sidebar.taskListMode.leaveInbox' : 'ccAgent.sidebar.taskListMode.enterInbox');
  return (
    <>
      <ChromeIconButton
        aria-label={label}
        aria-pressed={inbox}
        aria-description={showUnread ? t('bots.devicePicker.unread') : undefined}
        tooltip={label}
        tooltipSide="bottom"
        data-task-list-mode-toggle=""
        onClick={() => {
          setMode(inbox ? 'tasks' : 'inbox');
          if (!inbox && claimTaskInboxIntro()) setIntro(true);
        }}
        className={cn('relative shrink-0', inbox && '[--button-face-bg:var(--surface-hover)] text-[var(--text-primary)]')}
      >
        <ListChecks size={15} />
        {showUnread && <AttentionDot className="pointer-events-none absolute right-1 top-1" />}
      </ChromeIconButton>
      {intro ? <TaskInboxIntro open onClose={() => setIntro(false)} /> : null}
    </>
  );
}
