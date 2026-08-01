import { IPC_CHANNELS } from '@cindy/cindy-ipc';

/**
 * 会话 attention(未读)跨进程契约的单一来源。
 *
 * main → renderer 的会话已读广播 channel:main 侧 `clearSessionAttention`
 * (appBadgeService)每次清除后发,payload 为 `{ sessionId, intent }`。
 * 清除来源不止本机 renderer——device-link 远程控制端(手机 / 另一台桌面)看完
 * 会话后经远程 invoke 打进同一个 clear handler,本机 renderer 的
 * sessionAttentionStore 靠这条广播同步清侧栏红绿点(本机自己发起的清除收到
 * 回声做幂等 no-op)。发送方 appBadgeService、订阅方 preload fan-out、
 * 消费方 renderer store 三端共用本常量。
 */
export const SESSION_ATTENTION_CLEARED_CHANNEL = IPC_CHANNELS.NOTIFICATION.SESSION_ATTENTION_CLEARED;

/**
 * 清除会话 attention 的意图,随 IPC / 广播全链路透传:
 * 'explicit' = 用户真实看到了内容(可清未读 error);
 * 'passive' = 导航 / 聚焦类被动信号(对未读 error 免疫,fail-safe 默认)。
 */
export type SessionAttentionClearIntent = 'explicit' | 'passive';
