/**
 * UnclassifiedSection — 未绑定目录的草稿段
 * ---------------------------------------------------------------------------
 * 未分类草稿段视觉规格：
 *   - Draft Session (Unclassified)：高 32 / 圆角 8 / padding [0,8] / gap 10
 *   - circle-dashed icon 12×12 #a3a3a3
 *   - title Inter 14 italic normal，#737373 (Light) / #a3a3a3 (Dark)
 *
 * 渲染位置：在 ProjectsSection 内、Project 列表之上，与 Project Header 对齐。
 * 行为：单击导航 + hover 操作图标（与 SessionItem 一致），但视觉为草稿样式。
 *
 * 实现注意：草稿样式与普通 SessionItem 差异较大（italic + 灰色 + 不同 padding），
 * 不复用 SessionItem 而是另起一份小行内组件。重命名/删除功能本期保持现有
 * SessionItem 在未起名草稿行上的能力——草稿同样可走 SessionItem，只是套上"看起来像
 * 未绑定"的视觉壳。这里的实现：直接复用 SessionItem，让交互一致；外层不再叠加
 * Draft 样式，因为未起名草稿的视觉与设计稿一致（普通 32px 行）。设计稿 italic
 * 的灰字仅用于纯文字提示态——本期所有 unclassified 都是真实 Session（包括未起名
 * 草稿），照普通行渲染即可，标题由 `lib/sessionDisplayTitle` 兜底成「未命名对话」。
 */

import { SessionEntryList } from '../SessionEntryList';
import type { SessionClickHandler } from '../SessionItem';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from '../../lib/automationSidebarGrouping';
import type { Session } from '@/lib/ccAgent.types';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from '../sessionMoveTarget';

export interface UnclassifiedSectionProps {
  sessions: Session[];
  /**
   * F-PJ-10：父组件根据 filter.projects 是否为具体多选状态置 true →
   * 整段不渲染（只有 'all' 时才有"未分类"的视觉位置）。
   */
  hidden?: boolean;
  activeSessionId?: string;
  runningSessionIds: ReadonlySet<string>;
  /** /ctr 接管中的 sessionIds — SessionItem 用来切换左侧 icon */
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onMoveSession?: (id: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
}

export function UnclassifiedSection({
  sessions,
  hidden = false,
  activeSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions,
  onScheduleAction,
}: UnclassifiedSectionProps) {
  if (hidden) return null;
  if (sessions.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5 w-full">
      <SessionEntryList
        sessions={sessions}
        activeSessionId={activeSessionId}
        runningSessionIds={runningSessionIds}
        attachedSessionIds={attachedSessionIds}
        notifications={notifications}
        scheduleSessionIndex={scheduleSessionIndex}
        selectedSessionIds={selectedSessionIds}
        onSessionClick={onSessionClick}
        onAction={onAction}
        onRename={onRename}
        onTogglePin={onTogglePin}
        onMoveSession={onMoveSession}
        projectOptions={projectOptions}
        onScheduleAction={onScheduleAction}
      />
    </div>
  );
}
