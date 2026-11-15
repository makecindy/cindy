import i18next from 'i18next';

import type { FeishuBotStatus } from '@/hooks/useFeishuBot';

/** 传输层的连接错误文案随界面语言（imBot.text.transport.feishu.connection.*），先按当前语言原文比对，再用协议关键字兜底。 */
function isTransportText(error: string, key: string): boolean {
  const text = i18next.t(key);
  return Boolean(error) && text !== key && error.trim() === text.trim();
}

/** Saved credentials are binding state; transient transport status must not reopen the form. */
export function shouldShowSavedCredentialsCard(hasSavedCredentials: boolean): boolean {
  return hasSavedCredentials;
}

/** Maps the live transport state to an actionable explanation inside the bound card. */
export function savedCredentialsNoteKey(status: FeishuBotStatus, error?: string | null): string {
  switch (status) {
    case 'connected':
      return 'settings.feishuBot.connected.note';
    case 'testing':
      return 'settings.feishuBot.saved.connectingNote';
    case 'reconnecting':
      return 'settings.feishuBot.saved.reconnectingNote';
    case 'conflict':
      return 'settings.feishuBot.saved.conflictNote';
    case 'error':
      if (
        isTransportText(error ?? '', 'imBot.text.transport.feishu.connection.authFailed') ||
        isTransportText(error ?? '', 'imBot.text.transport.feishu.connection.authFailedDetail') ||
        /auth_failed|code: 514|App ID.*App Secret.*不正确/i.test(error ?? '')
      ) {
        return 'settings.feishuBot.saved.credentialsErrorNote';
      }
      if (/timed?\s*out|ETIMEDOUT/i.test(error ?? '')) {
        return 'settings.feishuBot.saved.timeoutErrorNote';
      }
      if (
        isTransportText(error ?? '', 'imBot.text.transport.feishu.connection.unreachable') ||
        /unable to connect|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|网络/i.test(error ?? '')
      ) {
        return 'settings.feishuBot.saved.networkErrorNote';
      }
      return 'settings.feishuBot.saved.errorNote';
    case 'idle':
      return 'settings.feishuBot.saved.idleNote';
  }
}
