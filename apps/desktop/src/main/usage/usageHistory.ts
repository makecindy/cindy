/**
 * usageHistory — 首页用量仪表盘的聚合查询 (main 侧, renderer 只渲染)。
 *
 * 数据源:
 *   - daily_spend: 日总额 canonical 来源 → 热力图 / streak / 今日 / 近 30 天总额 / 异常检测
 *   - daily_model_usage: 按模型拆分 (近 30 天), Codex 行美元在这里用 modelPricing 估算
 *     (读取时折算, 不在写入时冻结价格 — 价格表会变且离线时拿不到)
 *
 * 缓存策略:
 *   - 生产入口 readUsageHistory() 先 hydrate userData/cache/usage-history.json。
 *   - 有缓存时立即返回 stale payload, 后台刷新并写回磁盘; renderer 保持"更新中"感知并短轮询补 fresh。
 *   - 无缓存时才走同步聚合, 成功后落盘。纯函数 readUsageHistoryWith() 不带 IO 缓存, 便于单测。
 *
 * 设备范围 (device):
 *   - 'local' (默认): 只读本机库, 首页仪表盘沿用。
 *   - 'all': 本机 + 同账号其它电脑的原始行 (peerUsageSync 经 device-link 拉取并缓存),
 *     合并后走同一条聚合链路。设置 → 用量历史默认使用。
 *   - 其它值: 某一台其它电脑的 deviceId, 只聚合该设备的缓存行。
 *   多设备范围在其它设备同步期间返回 stale, renderer 的短轮询据此拿到合并后的结果。
 *
 * streak / anomaly / 估算全部是导出的纯函数, 单测不需要 DB / Electron。
 * 日期一律用本地时区 day key (localDayKey 同口径); renderer 以 payload.todayKey 为锚,
 * 不自己取系统日期。
 */

import { promises as fs } from 'node:fs';

import path from 'node:path';

import { app } from 'electron';

import { getAllSpendDays, localDayKey } from '../localDb/dailySpend';

import { getModelUsageSince, type DailyModelUsageRow } from '../localDb/dailyModelUsage';

import { getSessionUsageSince, getUsageTaskMeta } from '../localDb/dailySessionUsage';

import { getCurrentDbClientUserId } from '../localDb/client/current';

import { createLogger } from '../logger';

import {
  getGatewayModelPricing,
  isModelPricingRefreshInFlight,
  type ModelPricingMap,
} from './modelPricing';

import {
  getClaudeSubscriptionValuePrice,
  getCodexProviderSubscriptionValuePrice,
  getCodexSubscriptionValuePrice,
  getReferenceModelPricing,
  getSubscriptionDirectValuePrice,
  readModelPriceOverridesSnapshot,
  type ModelPriceOverridesSnapshot,
} from './referenceModelPricing';

import { computePriceQuoteTurnMoney } from './turnCostCalculator';

import {
  getPeerUsageSync,
  type PeerUsageSnapshot,
  type UsageDeviceSummary,
} from './peerUsageSync';

import type { UsageDeviceRows } from './usageDeviceRows';

import { currentLedgerCurrency } from './ledgerCurrency.js';

import {
  addCompatibleRegionalMoney,
  normalizeRegionalMoney,
  USD_TO_CNY_FIXED_RATE,
  type ModelPriceQuote,
  type MoneyCurrency,
  type RegionalMoney,
  zeroUsageMoney,
} from '../../shared/regionalMoney.js';


import {createSubscriptionValuePrice} from '@cindy/app-runtime/subscriptionValuePrice';
import {createUsageHistory} from '@cindy/app-runtime/usageHistory';
const runtime=createUsageHistory({addCompatibleRegionalMoney,normalizeRegionalMoney,USD_TO_CNY_FIXED_RATE,zeroUsageMoney,getAllSpendDays:(...args)=>getAllSpendDays(...args),localDayKey:(...args)=>localDayKey(...args),getModelUsageSince:(...args)=>getModelUsageSince(...args),getSessionUsageSince:(...args)=>getSessionUsageSince(...args),getUsageTaskMeta:(...args)=>getUsageTaskMeta(...args),getCurrentDbClientUserId:(...args)=>getCurrentDbClientUserId(...args),createLogger,getGatewayModelPricing:(...args)=>getGatewayModelPricing(...args),isModelPricingRefreshInFlight:(...args)=>isModelPricingRefreshInFlight(...args),readModelPriceOverridesSnapshot:(...args)=>readModelPriceOverridesSnapshot(...args),computePriceQuoteTurnMoney:(...args)=>computePriceQuoteTurnMoney(...args),getPeerUsageSync:(...args)=>getPeerUsageSync(...args),currentLedgerCurrency:(...args)=>currentLedgerCurrency(...args),userDataPath:()=>app.getPath('userData'),getClaudeSubscriptionValuePrice:(...args)=>getClaudeSubscriptionValuePrice(...args),getCodexProviderSubscriptionValuePrice:(...args)=>getCodexProviderSubscriptionValuePrice(...args),getCodexSubscriptionValuePrice:(...args)=>getCodexSubscriptionValuePrice(...args),getReferenceModelPricing:(...args)=>getReferenceModelPricing(...args),getSubscriptionDirectValuePrice:(...args)=>getSubscriptionDirectValuePrice(...args)});
export const {LOCAL_TASK_DEVICE,usageTaskKey,combineUsageDeviceRows,prevDayKey,shiftDayKey,computeStreaks,computeAnomaly,getSubscriptionValuePriceFor,readUsageHistoryWith,clampPeerRowsToToday,usageHistoryDepsForScope,readUsageHistory,emptyUsageHistoryPayload,__resetUsageHistoryCacheForTesting}=runtime;
export type {UsageHistoryDay,UsageHistoryModel,UsageHistoryModelDay,UsageHistoryPayload,UsageHistoryDeviceScope,UsageHistoryTaskDay,UsageHistoryTask,UsageHistoryDeps,UsageHistoryReadOptions} from '@cindy/app-runtime/usageHistory';
export {codexApiUsageModelKey,codexSubscriptionUsageModelKey,claudeSubscriptionUsageModelKey,piSubscriptionUsageModelKey} from '@cindy/app-runtime/usageModelKey';
