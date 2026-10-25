/**
 * usageBroadcaster — agent 今日累计 (cost / token) 广播,maker-ipc/usage.ts 的数据源。
 *
 * 设计:
 *   - Claude / Codex API: USD 累计 (持久化 sessions table 的 daily_spend, 跨 session 求和)
 *   - Codex 订阅: token 累计 (in-memory, app 重启 reset —— 订阅模式不产生真实 API cost,
 *             所以走 token; 不持久化是因为 token 数本身不是核算依据,粗略观感够了)
 *   - 切日: localDayKey() 与 currentSnapshot.day 不一致时 in-memory snapshot reset
 *           (Claude 走 SQLite per-day row, 不需要 in-memory reset)
 *
 * IPC 广播:
 *   - USAGE_TODAY_SPEND_CHANGED    每 turn done 后推 Claude USD 累计
 *   - USAGE_TODAY_TOKENS_CHANGED   每 turn done 后推 Codex token 累计 (按 agentKind)
 *   - USAGE_CODEX_ACCOUNT_CHANGED  推 Codex 账号订阅用量快照
 *   - USAGE_CLAUDE_SUBSCRIPTION_CHANGED 推 Claude 订阅账号余量快照 (5h/周/分模型窗口)
 *
 * 用户:
 *   - maker-ipc/register.ts: 在 maker:event done 时 record (Claude / Codex API → recordTurnSpend,
 *     Codex → recordCodexTurnUsage)
 *   - maker-ipc/usage.ts: maker:usage:today(agentKind) handler 读 readAgentTodayUsage
 */

import { BrowserWindow } from 'electron';

import { isTrustedAppRendererWindow } from './security/trustedAppRenderer.js';

import { incrementDailySpend, getTodaySpend, localDayKey } from './localDb/dailySpend';
import { getGatewayModelPricing } from './usage/modelPricing';
import type { XaiRateLimitSnapshot } from '../shared/xaiRateLimit';
import { incrementDailyModelUsage, type DailyModelUsageDelta } from './localDb/dailyModelUsage';
import { incrementDailySessionUsage } from './localDb/dailySessionUsage';
import { getCurrentDbClientUserId, getDbClient } from './localDb/client/current';
import {
  mergeClaudeSubscriptionUsageSnapshot,
  type ClaudeSubscriptionUsageSnapshot,
} from '../shared/claudeSubscriptionUsage';
import type { XaiSubscriptionUsageSnapshot } from '../shared/xaiSubscriptionUsage';
import type { AgentKind } from '@cindy/maker-core';

import {
  UNSAFE_BUCKET_KEYS,
  codexLimitBucketKey,
  isCodexBucketStale,
} from '@cindy/maker-shared/codex-usage-buckets';

import { createLogger } from './logger';
import { tapWindowBroadcast } from './device-link/broadcast-tap.js';
import { isDataOwnerBroadcastScopeCurrent, type DataOwnerBroadcastScope } from './device-link/broadcast-tap.js';
import type { RegionalMoney } from '../shared/regionalMoney.js';
import {createUsageBroadcaster} from '@cindy/app-runtime/usageBroadcaster';
export const {USAGE_TODAY_SPEND_CHANGED,USAGE_TODAY_TOKENS_CHANGED,USAGE_CODEX_ACCOUNT_CHANGED,USAGE_CODEX_ACCOUNT_AUTH_STARTED,USAGE_CODEX_ACCOUNT_AUTH_READY,USAGE_XAI_RATE_LIMIT_CHANGED,USAGE_XAI_PROVIDER_RATE_LIMIT_CHANGED,USAGE_CLAUDE_SUBSCRIPTION_CHANGED,USAGE_XAI_SUBSCRIPTION_CHANGED,recordTurnSpend,readTodaySpend,rebroadcastTodaySpend,recordModelTurnUsage,recordCodexTurnUsage,rebroadcastCodexTodayUsage,readAgentTodayUsage,splitPersistedCodexAccountUsage,recordCodexAccountUsageSnapshot,clearCodexAccountUsageSnapshot,broadcastCodexAccountAuthReady,broadcastCodexAccountAuthStarted,readCodexAccountUsageSnapshot,recordXaiRateLimitSnapshot,clearXaiRateLimitSnapshot,recordClaudeSubscriptionUsageSnapshot,clearClaudeSubscriptionUsageSnapshot,readClaudeSubscriptionUsageSnapshot,recordXaiSubscriptionUsageSnapshot,clearXaiSubscriptionUsageSnapshot,readXaiSubscriptionUsageSnapshot,observeUsageChanges,broadcastSubscriptionAccountUsage}=createUsageBroadcaster({incrementDailySpend:(...args)=>incrementDailySpend(...args),getTodaySpend:(...args)=>getTodaySpend(...args),localDayKey:(...args)=>localDayKey(...args),getGatewayModelPricing:(...args)=>getGatewayModelPricing(...args),incrementDailyModelUsage:(...args)=>incrementDailyModelUsage(...args),incrementDailySessionUsage:(...args)=>incrementDailySessionUsage(...args),getCurrentDbClientUserId:(...args)=>getCurrentDbClientUserId(...args),getDbClient:(...args)=>getDbClient(...args),createLogger:(...args)=>createLogger(...args),isDataOwnerBroadcastScopeCurrent:(...args)=>isDataOwnerBroadcastScopeCurrent(...args),tapWindowBroadcast:(...args)=>tapWindowBroadcast(...args),broadcastLocal(channel,payload,trusted){for(const win of BrowserWindow.getAllWindows())if(trusted?isTrustedAppRendererWindow(win):!win.isDestroyed())win.webContents.send(channel,payload);}});
export type {TodaySpendPayload,AgentTodayUsage,RateLimitWindow,CreditsSnapshot,RateLimitSnapshot,CodexAccountUsagePayload,UsageChangeKind} from '@cindy/app-runtime/usageBroadcaster';
export type {XaiRateLimitSnapshot} from '../shared/xaiRateLimit';
