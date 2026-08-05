/** Pure menu model shared by the message action sheet and tests. */
export type MobileMessageMenuActionId = 'fork' | 'add-to-chat' | 'copy-link' | 'rewind' | 'delete';

export interface MobileMessageMenuItem {
  id: MobileMessageMenuActionId;
  label: string;
  destructive?: boolean;
  separatorBefore?: boolean;
}

export function buildMobileMessageMenu(input: {
  canAddToChat: boolean;
  canCopyLink: boolean;
  canDelete: boolean;
  canFork: boolean;
  canRewind: boolean;
}): MobileMessageMenuItem[] {
  const items: MobileMessageMenuItem[] = [];
  if (input.canFork) items.push({ id: 'fork', label: '在新对话中继续' });
  if (input.canAddToChat) items.push({ id: 'add-to-chat', label: '添加到对话' });
  if (input.canCopyLink) items.push({ id: 'copy-link', label: '复制当前对话链接' });
  if (input.canRewind) items.push({ id: 'rewind', label: '回到此处' });
  if (input.canDelete) {
    items.push({
      id: 'delete',
      label: '删除本条对话',
      destructive: true,
      separatorBefore: items.length > 0,
    });
  }
  return items;
}
