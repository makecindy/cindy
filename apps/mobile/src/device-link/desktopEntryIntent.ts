/**
 * 桌面入口组件带来的目标。只在内存里，一次一个：不进路由参数、不写磁盘、不写日志。
 *
 * 登录墙之前由 `+native-intent.ts` 收下，登录就绪后由根级 Host 校验白名单再跳转。
 */
import { useSyncExternalStore } from 'react';

import {
  DESKTOP_ENTRY_MARKER,
  parseDesktopEntryLink,
  type ParsedDesktopEntryLink,
} from './desktopEntryModel';

export interface DesktopEntryIntent {
  readonly id: number;
  /** 白名单校验通过的页面；被篡改的链接为 null，Host 直接丢弃。 */
  readonly link: ParsedDesktopEntryLink | null;
}

let current: DesktopEntryIntent | null = null;
let sequence = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** 链接里出现「来自桌面入口」标记就算本功能链接；残缺的也收下，避免落到 404。 */
export function isDesktopEntryLink(path: string): boolean {
  const queryIndex = path.indexOf('?');
  if (queryIndex < 0) return false;
  const query = path.slice(queryIndex + 1).split('#')[0];
  return query.split('&').some((pair) => pair === DESKTOP_ENTRY_MARKER || pair.startsWith(`${DESKTOP_ENTRY_MARKER}=`));
}

/** 收下一条桌面入口链接。返回 true 表示调用方不应再把它交给路由。 */
export function receiveDesktopEntryLink(path: string): boolean {
  if (!isDesktopEntryLink(path)) return false;
  const link = parseDesktopEntryLink(path);
  // 路由器可能把同一次冷启动链接投递两次；同一个目标只保留一个待办，避免重复跳转。
  if (current && JSON.stringify(current.link) === JSON.stringify(link)) return true;
  current = { id: ++sequence, link };
  notify();
  return true;
}

/** 根级 Host 消费后清掉，避免同一目标在账号切换后再次跳转。 */
export function consumeDesktopEntryIntent(id: number): void {
  if (current?.id !== id) return;
  current = null;
  notify();
}

export const getDesktopEntryIntent = () => current;
export function subscribeDesktopEntryIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useDesktopEntryIntent = () => useSyncExternalStore(
  subscribeDesktopEntryIntent, getDesktopEntryIntent, getDesktopEntryIntent,
);
