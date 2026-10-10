/**
 * 供应商组替受邀者中转任务的纯函数部分(docs/product-rules/provider-groups.md §4、§8、§9)。
 *
 * 组所在电脑(本机)把受邀者的任务交给组内电脑运行时：
 *  - 受邀者在组内电脑上的身份是本机为它取的不透明键(relay)，不带分享与成员信息；
 *  - 受邀者的任务 id 换成按(受邀者, 任务 id)派生的 id，两个受邀者用同一个 id 也不会在组内电脑上撞车；
 *  - 组内电脑报出的、会透露它是谁或它与本机关系的错误，换成中性的「暂时不可用」；
 *  - 启动阶段换电脑时，每次尝试的 WebSocket 连接编号加前缀，不同尝试的连接不会混在一起。
 */
import { createHash } from 'node:crypto';

import type { RemoteAgentErrorInfo } from '@cindy/device-link';

/** 受邀者在组内电脑上的不透明键(32 位十六进制)。 */
export function relayKeyFor(guestController: string): string {
  return createHash('sha256').update(`provider-group-relay\0${guestController}`).digest('hex').slice(0, 32);
}

/** 受邀者任务在组内电脑上的任务 id。 */
export function relaySessionIdFor(guestController: string, sessionId: string): string {
  return `g${createHash('sha256').update(`${guestController}\0${sessionId}`).digest('hex').slice(0, 40)}`;
}

/**
 * 组内电脑那边的路径类错误(那台对本机的分享暂停 / 删除、没开远程调用、换了账号、太旧、连不上、太忙)
 * 对受邀者没有意义，还会透露组内电脑与本机的关系：统一成「暂时不可用」。Agent 本身的报错(用量上限等)
 * 在事件流里，不经过这里。
 */
const LOCATION_CODES = /^REMOTE_AGENT_(?:SHARE_PAUSED|SHARE_REMOVED|SHARE_UNAVAILABLE|PROVIDER_NOT_ALLOWED|ACCOUNT_CHANGED|PEER_TOO_OLD|DEVICE_UNREACHABLE|BUSY|UNAVAILABLE)$|^(?:ACCESS_REVOKED|REMOTE_DISABLED|CHANNEL_NOT_ALLOWED|UNSUPPORTED_CAPABILITY|DEVICE_OFFLINE|PEER_RESET|TIMEOUT|INVOKE_TIMEOUT|LINK_CLOSED|LINK_NOT_OPEN|NOT_CONNECTED)$/;

export const RELAY_UNAVAILABLE_ERROR: RemoteAgentErrorInfo = {
  code: 'REMOTE_AGENT_UNAVAILABLE',
  message: '[REMOTE_AGENT_UNAVAILABLE] The computer running this task is not available right now.',
};

export function relayErrorForGuest(info: RemoteAgentErrorInfo | undefined): RemoteAgentErrorInfo | undefined {
  if (!info) return undefined;
  const code = /^\[([A-Z][A-Z0-9_]+)\]/.exec(info.message)?.[1] ?? info.code;
  return LOCATION_CODES.test(code) ? { ...RELAY_UNAVAILABLE_ERROR } : info;
}

export function relayErrorInfoFrom(error: unknown): RemoteAgentErrorInfo {
  const err = error instanceof Error ? error : new Error(String(error));
  const rawCode = (err as unknown as { code?: unknown }).code;
  const code = /^\[([A-Z][A-Z0-9_]+)\]/.exec(err.message)?.[1]
    ?? (typeof rawCode === 'string' && rawCode ? rawCode : 'AGENT_ERROR');
  const info: RemoteAgentErrorInfo = { code: code.slice(0, 128), message: err.message.slice(0, 2048), name: err.name };
  return relayErrorForGuest(info) ?? info;
}

/** 第 attempt 次启动尝试的 WebSocket 连接编号(受邀者看到的)。 */
export function relayConnId(attempt: number, connId: string): string {
  return `r${attempt}-${connId}`.slice(0, 64);
}

/** 受邀者推来的帧属于哪次尝试的哪条连接；不是当前尝试的返回 null(丢弃)。 */
export function relayMemberConnId(attempt: number, guestConnId: string): string | null {
  const prefix = `r${attempt}-`;
  return guestConnId.startsWith(prefix) ? guestConnId.slice(prefix.length) : null;
}
