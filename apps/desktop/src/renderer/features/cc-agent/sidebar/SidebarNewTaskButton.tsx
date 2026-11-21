/**
 * SidebarNewTaskButton —— 任务列表段头最右侧的「＋」。
 * ---------------------------------------------------------------------------
 * 与左上角导航行的「新建」、⌘N 是**同一个动作**:打开 /cc-agent/new 草稿页,由
 * makeGenericNewMakerRouteState 恢复上次成功创建的电脑与项目(#11420)。段头标题
 * 显示的是「正在看什么」,不是「新任务去哪台电脑」,所以这里不读机器范围——与项目行、
 * 对话组头那种带设备归属的入口([onCreateDialogue])刻意不同,离线的远程设备也不禁用
 * (左上角的新建在这些范围下同样可点)。
 *
 * 只画按钮本身,不带走显隐:显隐是所在行的职责(段头用 HEADER_HOVER_ACTION_CLASS 包)。
 * 这样布局重排——例如 #11708 把「全部任务 ▾」整行换成横向标签 + 电脑行——可以原样
 * 搬过去,不必重新实现一个入口。
 */
import type { ReactNode } from 'react';
import { CirclePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useNewMakerDraftEntry } from '../hooks/useNewMakerDraftEntry';

export function SidebarNewTaskButton(): ReactNode {
  const { t } = useTranslation();
  const openNewTask = useNewMakerDraftEntry();
  const label = t('ccAgent.sidebar.newDialogue');

  return (
    <Tip text={label} side="bottom">
      <Button
        variant="secondary"
        tone="quiet"
        size="sm"
        aria-label={label}
        onClick={openNewTask}
        className={cn(
          'w-7 px-0',
          // 配色与段头其余按钮同源。quiet 默认给 --text-secondary(深色下 #a3a3a3,
          // 比段头的 --sidebar-list-muted #6F6F6F 亮一大截),用 :not(:disabled) 提高
          // 特异性盖掉它,不依赖两个 text-* 工具类的生成顺序。
          '[&:not(:disabled)]:text-[var(--sidebar-list-muted)]',
          'hover:text-[var(--sidebar-nav-text)]',
        )}
      >
        <CirclePlus size={14} strokeWidth={2} />
      </Button>
    </Tip>
  );
}
