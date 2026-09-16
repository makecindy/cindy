import type { FeishuBotStatus } from '@/hooks/useFeishuBot';

/** Saved credentials are binding state; transient transport status must not reopen the form. */
export function shouldShowSavedCredentialsCard(hasSavedCredentials: boolean): boolean {
  return hasSavedCredentials;
}

/** 开放平台控制台入口: 扫码建出来的 App 得用户自己去后台补事件订阅。 */
export const FEISHU_OPEN_PLATFORM_URLS: Record<'feishu' | 'lark', string> = {
  feishu: 'https://open.feishu.cn/app?lang=zh-CN',
  lark: 'https://open.larksuite.com/app',
};

/**
 * Maps the live transport state to an actionable explanation inside the bound card.
 *
 * 已连接那句「其他人私聊会被忽略」只在开关关着时成立 —— 开关打开后同一页面上
 * 会同时出现两个相反的访问结论, 所以按开关换一句。其它档位与访客开关无关。
 */
export function savedCredentialsNoteKey(
  status: FeishuBotStatus,
  allowStrangerChats: boolean,
): string {
  switch (status) {
    case 'connected':
      return allowStrangerChats
        ? 'settings.feishuBot.connected.noteStrangersAllowed'
        : 'settings.feishuBot.connected.note';
    case 'testing':
      return 'settings.feishuBot.saved.connectingNote';
    case 'reconnecting':
      return 'settings.feishuBot.saved.reconnectingNote';
    case 'conflict':
      return 'settings.feishuBot.saved.conflictNote';
    case 'error':
      return 'settings.feishuBot.saved.errorNote';
    case 'idle':
      return 'settings.feishuBot.saved.idleNote';
  }
}
