import type { FeishuBotStatus } from '@/hooks/useFeishuBot';

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
      if (/auth_failed|code: 514|App ID.*App Secret.*不正确/i.test(error ?? '')) {
        return 'settings.feishuBot.saved.credentialsErrorNote';
      }
      if (/timed?\s*out|ETIMEDOUT/i.test(error ?? '')) {
        return 'settings.feishuBot.saved.timeoutErrorNote';
      }
      if (/unable to connect|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|网络/i.test(error ?? '')) {
        return 'settings.feishuBot.saved.networkErrorNote';
      }
      return 'settings.feishuBot.saved.errorNote';
    case 'idle':
      return 'settings.feishuBot.saved.idleNote';
  }
}
