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
  // 文案与 desktop 的 chat.messageActionBar.* 保持一致(那边走 i18n,这里暂为硬编码):
  // fork 产出的是一条新任务;copy-link 复制的是带 messageClientId 的消息深链;
  // delete 删的是单条消息。「添加到对话」指发进当前对话流,按 naming 规则保持「对话」。
  if (input.canFork) items.push({ id: 'fork', label: '开启一个新任务' });
  if (input.canAddToChat) items.push({ id: 'add-to-chat', label: '添加到对话' });
  if (input.canCopyLink) items.push({ id: 'copy-link', label: '复制当前消息链接' });
  if (input.canRewind) items.push({ id: 'rewind', label: '回到此处' });
  if (input.canDelete) {
    items.push({
      id: 'delete',
      label: '删除本条消息',
      destructive: true,
      separatorBefore: items.length > 0,
    });
  }
  return items;
}
