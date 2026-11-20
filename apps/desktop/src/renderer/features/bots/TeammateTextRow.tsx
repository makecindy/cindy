import type { KeyboardEventHandler, MouseEventHandler, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { SidebarRightStatusIndicator } from '@/features/cc-agent/sidebar/SidebarRightStatusIndicator';
import type { TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { companionDragProps } from './companionDragProps';

/**
 * 侧栏伙伴段的一行:与任务行同一套几何(高 32、胶囊、左 12 / 右 8、正文 14px),
 * 只有名字。正在干活的行尾一个灰色转圈;等你回复 / 出错 / 有未读时名字加粗,
 * 不画头像、彩色状态点、预览和时间(2026-11-19 用户裁决)。
 */
export function TeammateTextRow({
  name,
  status,
  selected,
  route,
  onOpen,
  onContextMenu,
  onKeyDown,
  trailing,
  dataAttributes,
  children,
}: {
  name: string;
  status: TeammateStatus;
  selected: boolean;
  /** 聊天路由:整行可拖进分屏(与旧的伙伴行、群聊行同一套拖拽)。 */
  route?: string;
  onOpen: () => void;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  /** 名字后面的可交互控件(如 Cindy 的电脑切换),不参与整行点击。 */
  trailing?: ReactNode;
  dataAttributes?: Record<`data-${string}`, string>;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const bold = status === 'awaiting' || status === 'error' || status === 'done' || status === 'unread';
  const statusLabel = status === 'idle' ? null : t(`bots.avatarStatus.${status}`);
  return (
    <div
      {...dataAttributes}
      data-teammate-row
      data-teammate-status={status}
      className={cn(
        'group relative flex h-8 w-full items-center gap-2.5 rounded-full pr-2 pl-3 select-none',
        selected
          ? 'bg-sidebar-item-active text-sidebar-item-active-foreground shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)]'
          : 'text-foreground hover:bg-sidebar-item-hover',
      )}
    >
      <button
        type="button"
        {...companionDragProps(route, name)}
        onClick={onOpen}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        aria-current={selected ? 'page' : undefined}
        aria-label={statusLabel ? `${name} · ${statusLabel}` : name}
        className="absolute inset-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <span
        className={cn(
          'pointer-events-none relative min-w-0 truncate text-sm leading-5',
          bold ? 'font-semibold' : 'font-normal',
        )}
        title={name}
      >
        {name}
      </span>
      {trailing ? <span className="relative flex min-w-0 shrink items-center">{trailing}</span> : null}
      {status === 'running' ? (
        <SidebarRightStatusIndicator kind="running" isActive={selected} className="pointer-events-none relative ml-auto shrink-0" />
      ) : null}
      {children}
    </div>
  );
}
