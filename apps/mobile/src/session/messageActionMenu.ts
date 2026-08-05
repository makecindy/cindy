/**
 * Pure menu model shared by the message action sheet and tests.
 *
 * 文案走 i18n（与同目录 `sessionMenu.ts` 同规）：这些 label 会直接渲染成
 * `MessageActionSheet` 的可视文本与无障碍标签，mobile 支持 en / ja / ko，
 * 塞硬编码中文会让非中文语言环境看到中文菜单。
 */
import { i18n } from '@/i18n';

export type MobileMessageMenuActionId = 'add-to-chat' | 'copy-link' | 'rewind' | 'delete';

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
  canRewind: boolean;
}): MobileMessageMenuItem[] {
  const items: MobileMessageMenuItem[] = [];
  // 语义与 desktop 的 chat.messageActionBar.* 一一对应:fork 产出的是一条新任务;
  // fork 已与复制同级外显;copy-link 复制的是带 messageClientId 的消息深链;
  // delete 删的是单条消息。
  // 「添加到对话」指发进当前对话流,按 naming 规则保持「对话」。
  if (input.canAddToChat) {
    items.push({ id: 'add-to-chat', label: i18n.t('session.messageMenu.addToChat') });
  }
  if (input.canCopyLink) {
    items.push({ id: 'copy-link', label: i18n.t('session.messageMenu.copyLink') });
  }
  if (input.canRewind) items.push({ id: 'rewind', label: i18n.t('session.messageMenu.rewind') });
  if (input.canDelete) {
    items.push({
      id: 'delete',
      label: i18n.t('session.messageMenu.deleteOne'),
      destructive: true,
      separatorBefore: items.length > 0,
    });
  }
  return items;
}
