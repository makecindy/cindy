/**
 * 会话终态通知文案的 main 侧统一入口。
 *
 * Desktop toast、Device Link 手机推送和普通会话的飞书私聊都从这里读取同一组
 * renderer locale key。函数每次调用都现场执行 t()，因此 renderer 通过
 * setMainLocale() 切换语言后，下一条通知会立即跟随，不需要额外缓存或事件机制。
 */
import { t } from './i18n.js';

export type SessionEventKind = 'done' | 'error' | 'needs-reply';

const BODY_KEY_BY_KIND: Record<SessionEventKind, string> = {
  done: 'settings.notifications.sessionEvent.done',
  error: 'settings.notifications.sessionEvent.error',
  'needs-reply': 'settings.notifications.sessionEvent.needsReply',
};

const EXTERNAL_KEY_BY_KIND: Record<SessionEventKind, string> = {
  done: 'settings.notifications.sessionEvent.externalDone',
  error: 'settings.notifications.sessionEvent.externalError',
  'needs-reply': 'settings.notifications.sessionEvent.externalNeedsReply',
};

export function getSessionNotificationBody(kind: SessionEventKind): string {
  return t(BODY_KEY_BY_KIND[kind]);
}

export function getSessionNotificationUntitled(): string {
  return t('settings.notifications.sessionEvent.untitled');
}

export function getSessionExternalNotificationText(title: string, kind: SessionEventKind): string {
  // replacement 必须是函数：任务标题是原样数据，`$&` / `$\`` / `$'` / `$$`
  // 等 JavaScript replacement token 不能被解释成模板控制符。
  return t(EXTERNAL_KEY_BY_KIND[kind]).replaceAll('{{title}}', () => title);
}
