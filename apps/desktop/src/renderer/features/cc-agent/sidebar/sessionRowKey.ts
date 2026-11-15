import type { Session } from '@/lib/ccAgent.types';

/**
 * 侧栏任务行的 React key。不同电脑上可以有同 id 的任务（恢复或复制的数据库与远程镜像并存），
 * 只用 id 会让 React 漏删其中一行，留下点不掉、内容错位的残影。
 */
export function sessionRowKey(session: Pick<Session, 'id' | 'deviceLinkDeviceId'>): string {
  return `${session.deviceLinkDeviceId ?? ''}:${session.id}`;
}
