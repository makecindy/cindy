import { refreshQuotaCredentialOwner, cloudQuotaOwnerKey, quotaCredentialsReady, quotaCredentialGeneration, onQuotaCredentialSourceChanged } from '../model-access/quotaCredentialState.js';
import type { ClaudeQuotaClear } from '../../shared/claudeQuotaState.js';
import { readOrganizationAccountUsage } from './organizationAccountUsage.js';
/**
 * claudeAccountUsage — Claude 账号配额 (LiteLLM spend / max_budget) 拉取与广播。
 *
 * 配额周期:
 *   字段来自 LiteLLM /v2/user/info 的 spend / max_budget / budget_reset_at。
 *   网关当前部署 budget_duration='30d', 所以 cycleSpend 是"本月度周期 (距上次 reset)
 *   跨所有客户端 / 所有 API key 的累计花费", cycleMaxBudget 是月度上限。
 *
 * 今日跨客户端 (todaySpend):
 *   走 LiteLLM /user/daily/activity?start_date=<UTC today>&end_date=<UTC today>, 返回
 *   results[0].metrics.spend (本 user 名下跨所有客户端 / 所有 API key 的当日累计, 与 web
 *   看板同源)。UTC 日切, 跟 web 看板边界完全对齐。
 *   历史: 早期网关没开这个端点, 改用 dailyBaselineStore (本机 baseline diff) 反推,
 *   现已下线 (2026-05-22 GateWay 同事 ship 后)。
 *   注: 曾额外用 /key/info + breakdown.api_keys 算"当前 API key 今日", 但 /key/info 解析到
 *   的是管理用途 key, 与子进程实际计费 key 不是同一把, 取出来的桶并非用户真实用量;
 *   且 todaySpend 已是本 user 当日全部用量, 该指标冗余, 2026-06-21 移除。
 *
 * 设计取舍 (与 usageBroadcaster.ts 拆开的理由):
 *   - usageBroadcaster.ts 原本职责 = 本机 SQLite 累加的"今日金额" + Codex token, 是
 *     turn 收尾的"记账"层。账号配额是"账号画像"层, 来源是 HTTP API 而非 SDK turn delta —
 *     两件事不同步 (前者写 SQLite + 同步广播, 后者 fire-and-forget + 节流), 强行混在
 *     一个文件里会让 broadcaster 的 turn-done 路径多一个 IO side-effect。
 *   - 拆出后:
 *     · usageBroadcaster 回到只管"两类本机累计"
 *     · register.ts turn-done handler 并列调用 recordTurnSpend(...) 与本模块的
 *       triggerClaudeAccountUsageRefresh() — 两个 side-effect 平级显式
 *     · 鉴权 / endpoint 来源走 maker-host (auth-adapters + runtime-configs), 不再
 *       直接读 process.env (生产链路下 ANTHROPIC_API_KEY 是空的, 真 key 在
 *       safeStorage 加密存)
 *
 * 节流与超时:
 *   - 单次 fetch 8s AbortController 超时
 *   - 距上次成功 / 失败拉取 < 10s 直接跳过 (force=true 跳过节流, IPC handler warm-start 用)
 *   - in-flight 去重 — 防 turn 密集时排队
 *
 * 失败语义:
 *   - env / 鉴权缺 / /v2/user/info 非 2xx / 超时 → 返 null, 不写 snapshot, 不广播
 *   - /user/daily/activity 非 2xx / 超时 → 仍广播月度 snapshot, todaySpend=null,
 *     renderer 隐藏 Daily 段并在 tooltip 标注端点暂不可用
 */

import { BrowserWindow } from 'electron';

import type { MoneyCurrency } from '../../shared/regionalMoney';
import { getAuthState } from '../authManager';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { createLogger } from '../logger';
import { readClaudeApiKey } from '../maker-host/auth-adapters';
import { reportCindyGatewayKeyRejected } from '../model-access/gatewayKeyRejection';
import { outboundFetch } from '../maker-host/outbound-fetch';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs';
import { getGatewayAccountCurrency } from './modelPricing';
import { currentLedgerCurrency } from './ledgerCurrency';
import {createClaudeAccountUsage} from '@cindy/app-runtime/claudeAccountUsage';
export const {USAGE_CLAUDE_ACCOUNT_CHANGED,__resetClaudeAccountUsageForTesting,triggerClaudeAccountUsageRefresh,readClaudeAccountUsageSnapshot,readClaudeAccountQuotaClear,readClaudeAccountUsageRevision,observeClaudeAccountUsage}=createClaudeAccountUsage({refreshQuotaCredentialOwner:(...args)=>refreshQuotaCredentialOwner(...args),cloudQuotaOwnerKey:(...args)=>cloudQuotaOwnerKey(...args),quotaCredentialsReady:(...args)=>quotaCredentialsReady(...args),quotaCredentialGeneration:(...args)=>quotaCredentialGeneration(...args),onQuotaCredentialSourceChanged:(...args)=>onQuotaCredentialSourceChanged(...args),readOrganizationAccountUsage:(...args)=>readOrganizationAccountUsage(...args),getAuthState:(...args)=>getAuthState(...args),tapWindowBroadcast:(...args)=>tapWindowBroadcast(...args),createLogger:(...args)=>createLogger(...args),readClaudeApiKey:(...args)=>readClaudeApiKey(...args),reportCindyGatewayKeyRejected:(...args)=>reportCindyGatewayKeyRejected(...args),outboundFetch:(...args)=>outboundFetch(...args),claudeUpstreamEndpoint:(...args)=>claudeUpstreamEndpoint(...args),getGatewayAccountCurrency:(...args)=>getGatewayAccountCurrency(...args),currentLedgerCurrency:(...args)=>currentLedgerCurrency(...args),broadcastLocal(channel,payload){for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send(channel,payload);}});
export type {ClaudeAccountUsageSnapshot} from '@cindy/app-runtime/claudeAccountUsage';
