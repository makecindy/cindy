/**
 * sessionTaskSummary — 置顶会话的"任务现状一句话摘要"生成器
 * ---------------------------------------------------------------------------
 * sidebar-card-mode redesign:置顶卡片不再展示"最近消息前 140 字"原文,
 * 而是一句概括"任务是什么 + 当前进展"。列表/文字模式不展示摘要。
 *
 * 生成时机(两处调用方,都 fire-and-forget):
 *   1. maker-ipc/register.ts — turn 结束(done event)
 *   2. localDb/ipc/sessions.ts — 会话被置顶那一刻(动态 import 避免模块环)
 * 两处都还要满足「置顶段当前是卡片模式」(由 renderer 通知)。
 * 列表/文字模式下的 turn-done(force)会清掉旧摘要,切回卡片时由回填按最新内容重写。
 *
 * 成本控制(对齐 title.ts 的口径):
 *   - 仅 status='active' 且 pinnedAt 非空、置顶段是卡片模式时生成
 *   - maker.oneShot 路由到低价模型(Claude → haiku / Codex → mini),maxTokens 80
 *   - per-session in-flight 守卫 + 20s 节流,失败 swallow
 *
 * 落库直写 summary 列,**不碰 updatedAt**(避免 sidebar 重排),完成后广播
 * local-db:sessions:patched 让 renderer 即时刷新(与 fbotTitle 同通道)。
 *
 * 纯逻辑(档位选择 / sanitize / 定时识别 / 素材判定 / prompt)抽到
 * sessionTaskSummary.logic.ts,便于单测且本文件运行时直接复用——无平行实现漂移。
 */

import { BrowserWindow } from 'electron';
import { and, count, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { getMaker } from './maker-host/index.js';
import { isAgentOneShotRouteDisabled } from './maker-host/model-route-guard-live.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from './appSessionState.js';
import { agentSupportsOneShot, requestUtilityText } from './utility-model/oneShotCandidates.js';
import {
  getEffectiveAuxiliaryModelChain,
  getEffectiveAuxiliaryModelChainSnapshot,
} from './utility-model/resolveAuxiliaryModelChain.js';
import { getDbClient } from './localDb/client/current.js';
import { latestMessageText, latestVisiblePreview } from './localDb/latestMessageText.js';
import { messages, sessions } from './localDb/schema.js';
import { createLogger } from './logger.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
  type DataOwnerBroadcastScope,
} from './device-link/broadcast-tap.js';
import {
  STALE_SHORT_MS,
  SUMMARY_STALE_MAX_CHARS,
  SUMMARY_PROMPT,
  sanitize,
  isScheduledSession,
  pickTier,
  maxCharsForTier,
  hasSummarizableMaterial,
  shouldGeneratePinnedCardSummary,
  shouldVoidSummaryAfterGenerationAttempt,
  nonCardTurnDisplayPatch,
  sessionListPreviewPatch,
  shouldForceGenerateOnClear,
  shouldScheduleForceGenerateAfterInFlight,
} from './sessionTaskSummary.logic.js';
import {createSessionTaskSummary} from '@cindy/app-runtime/sessionTaskSummary';
export const {broadcastSessionListPreview,refreshSessionListPreview,setPinnedSectionCardMode,maybeGenerateSessionTaskSummary,backfillPinnedSessionSummaries}=createSessionTaskSummary({getMaker:(...args)=>getMaker(...args),isAgentOneShotRouteDisabled:(...args)=>isAgentOneShotRouteDisabled(...args),activeOwnerScopeKey:(...args)=>activeOwnerScopeKey(...args),isAppSessionBoundaryPending:(...args)=>isAppSessionBoundaryPending(...args),agentSupportsOneShot:(...args)=>agentSupportsOneShot(...args),requestUtilityText:(...args)=>requestUtilityText(...args),getEffectiveAuxiliaryModelChain:(...args)=>getEffectiveAuxiliaryModelChain(...args),getEffectiveAuxiliaryModelChainSnapshot:(...args)=>getEffectiveAuxiliaryModelChainSnapshot(...args),getDbClient:(...args)=>getDbClient(...args),latestMessageText:(...args)=>latestMessageText(...args),latestVisiblePreview:(...args)=>latestVisiblePreview(...args),createLogger:(...args)=>createLogger(...args),captureDataOwnerBroadcastScope:(...args)=>captureDataOwnerBroadcastScope(...args),isDataOwnerBroadcastScopeCurrent:(...args)=>isDataOwnerBroadcastScopeCurrent(...args),tapWindowBroadcast:(...args)=>tapWindowBroadcast(...args),broadcastLocal(channel,payload,...stamp){for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed()){try{win.webContents.send(channel,payload,...stamp);}catch{}}}});
