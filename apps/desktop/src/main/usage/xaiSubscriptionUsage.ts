/**
 * xaiSubscriptionUsage(main) — 拉取 SuperGrok 账号周用量。
 *
 * 配额权威源只有 settings + billing?format=credits,共用独立超时信号。
 * /v1/user 与 userinfo 是可选 identity:独立短超时,失败或超时不得 abort 配额请求。
 *
 * 请求头与模型发现共用 buildXaiCliProxyHeaders。邮箱/姓名/完整响应当场丢弃。
 * settings/billing 的 401/403/429 才控制配额可用性;5xx / 半成功无字段返回 null 保缓存。
 * 仅当 currentPeriod.type=USAGE_PERIOD_TYPE_WEEKLY、窗口未结束、
 * 且响应里没有 creditUsagePercent 键时,视为 0%(重置后常见)。
 * 字段在但解不出数,仍当残缺 200 保缓存。
 */

import { createHash } from 'node:crypto';

import { createLogger } from '../logger.js';
import {
  XAI_ACCOUNT_USER_URL,
  buildXaiCliProxyHeaders,
} from '../maker-host/model-discovery/xai.js';
import {
  buildXaiSubscriptionUsageSnapshot,
  parseXaiBillingCreditsConfig,
  parseXaiSettingsPlanLabel,
  type XaiSubscriptionUsageSnapshot,
} from '../../shared/xaiSubscriptionUsage.js';
import {createXaiSubscriptionUsage} from '@cindy/app-runtime/xaiSubscriptionUsage';
export const {XaiSubscriptionUsageUnauthorizedError,XaiSubscriptionUsageRateLimitedError,XAI_SUBSCRIPTION_USAGE_EMPTY,fingerprintXaiSubject,fetchXaiSubscriptionUsageSnapshot}=createXaiSubscriptionUsage({createLogger,XAI_ACCOUNT_USER_URL,buildXaiCliProxyHeaders});
export type {XaiSubscriptionUsageFetchResult} from '@cindy/app-runtime/xaiSubscriptionUsage';
