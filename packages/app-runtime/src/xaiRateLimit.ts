/**
 * xAI(SuperGrok bridge)上游限流快照 —— bridge 每个成功响应解析 `x-ratelimit-*` 头产出。
 * main(usageBroadcaster 记录 + 广播)与 renderer(useXaiRateLimit 消费)共用本形状,
 * 字段与 @cindy/anthropic-responses-bridge 的 UpstreamRateLimitInfo 对齐(+ updatedAt)。
 */
export interface XaiRateLimitSnapshot {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
  /** epoch ms,main 记录时刻。 */
  updatedAt: number;
}
