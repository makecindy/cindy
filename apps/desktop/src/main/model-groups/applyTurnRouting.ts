/**
 * 任务中间持续托管发前执行器(纯 Node，Desktop 与 Node Host 共用)。
 *
 * 组合 `evaluateModelGroupBeforeSend` 与宿主的同引擎/跨引擎/跨位置切换入口：
 * - 在发送锁内执行，不阻断正常发送(任何异常降级记录日志并沿用当前来源)；
 * - 切源成功后原子更新 `model-group-session-bindings.json` 并写入换源说明卡；
 * - 共享任务在宿主上下文下以 owner 权执行，不暴露宿主私密信息给访客。
 */
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '@cindy/maker-core';
import { dbToMakerAgentKind, makerToDbAgentKind } from '../../shared/agentKindConversion.js';
import {
  modelGroupCandidateKey,
  type ModelGroupAgentKind,
  type ModelGroupRouteNote,
  type ModelGroupSelection,
} from '../../shared/modelGroups.js';
import { createLogger } from '../logger.js';
import { bindModelGroupSession } from './sessionBindings.js';
import type {
  ModelGroupTurnContext,
  ModelGroupTurnCurrentRoute,
  ModelGroupTurnDecision,
  ModelGroupTurnDecisionSwitch,
} from './turnRouting.js';

const log = createLogger('model-groups:turn-routing');

/** 检测发送消息正文或待持久化附件信封中是否包含图片输入。 */
export function messageContainsImage(message: unknown, persistUserMessageContent?: unknown): boolean {
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'image') {
          return true;
        }
      }
    }
  }
  if (typeof persistUserMessageContent === 'string' && persistUserMessageContent.startsWith('{')) {
    try {
      const parsed = JSON.parse(persistUserMessageContent) as {
        images?: unknown[];
        files?: Array<{ category?: unknown }>;
      };
      if (Array.isArray(parsed.images) && parsed.images.length > 0) return true;
      if (Array.isArray(parsed.files) && parsed.files.some((f) => f?.category === 'image')) return true;
    } catch {
      // 普通文本消息恰好以 `{` 开头，按无图片处理。
    }
  }
  return false;
}

export interface RunModelGroupBeforeSendSessionRow {
  source?: string | null;
  agentKind?: string | null;
  providerId?: string | null;
  model?: string | null;
  effort?: string | null;
  fastMode?: boolean | 'ultrafast' | null;
  agentDeviceId?: string | null;
  remoteHostId?: string | null;
  lastTurnEndedAt?: number | null;
  contextTokens?: number | null;
}

export interface RunModelGroupBeforeSendPorts {
  readSession(sessionId: string): Promise<RunModelGroupBeforeSendSessionRow | null>;
  /** 伙伴会话尚无会话级覆盖绑定时，可返回伙伴 profile 主槽配置的 modelGroup。 */
  readBotProfileModelGroup?(sessionId: string): Promise<ModelGroupSelection | null>;
  evaluateTurnRouting(
    sessionId: string,
    current: ModelGroupTurnCurrentRoute,
    turn: ModelGroupTurnContext,
  ): Promise<ModelGroupTurnDecision>;
  applySameEngineRoute(params: {
    sessionId: string;
    model: string;
    providerId: string;
    effort: string | null;
    fastMode: boolean | 'ultrafast';
  }): Promise<{
    deferred?: boolean;
    superseded?: boolean;
    persistedRoute?: boolean;
    effectiveModelId?: string;
    effectiveProviderId?: string | null;
    contextWindowConfirmationRequired?: number;
  }>;
  performCrossSwitch(params: {
    sessionId: string;
    targetAgentKind: AgentKind;
    agentDeviceId: string | null;
    model: string;
    providerId: string;
    effort?: string;
    fastMode?: boolean | 'ultrafast';
    skipBootstrap: boolean;
  }): Promise<{ switched: boolean }>;
  writeSwitchNote?(sessionId: string, note: ModelGroupRouteNote, clientId: string): Promise<void>;
  describeCause?(cause: ModelGroupTurnDecisionSwitch['cause']): string;
  runAsOwner?<T>(work: () => Promise<T>): Promise<T>;
}

const DEFAULT_CAUSE_LABELS: Record<ModelGroupTurnDecisionSwitch['cause'], string> = {
  'preflight-unavailable': 'Current source unavailable before send',
  'image-input': 'Switched to a vision-capable source for images',
  'cache-expired': 'Re-evaluated after prompt cache expired',
};

function asModelGroupAgentKind(value: string | null | undefined): ModelGroupAgentKind | null {
  if (value === 'cc' || value === 'claude-code') return 'cc';
  if (value === 'codex' || value === 'pi') return value;
  return null;
}

export async function runModelGroupBeforeSend(
  ports: RunModelGroupBeforeSendPorts,
  sessionId: string,
  options: {
    hasImages?: boolean;
    autoResume?: boolean;
    bootstrapAfterSwitch?: boolean;
    scheduled?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{ switched: boolean; decision?: ModelGroupTurnDecisionSwitch }> {
  if (options.signal?.aborted || options.scheduled) return { switched: false };

  const execute = async (): Promise<{ switched: boolean; decision?: ModelGroupTurnDecisionSwitch }> => {
    const row = await ports.readSession(sessionId);
    if (!row || !row.providerId || !row.model) return { switched: false };
    const agentKind = asModelGroupAgentKind(row.agentKind);
    if (!agentKind) return { switched: false };

    const overrideSelection = row.source === 'bot' && ports.readBotProfileModelGroup
      ? await ports.readBotProfileModelGroup(sessionId).catch(() => null)
      : null;

    const decision = await ports.evaluateTurnRouting(
      sessionId,
      {
        source: row.source,
        agentKind,
        providerId: row.providerId,
        model: row.model,
        agentDeviceId: row.agentDeviceId ?? null,
        effort: row.effort ?? null,
        fastMode: row.fastMode ?? false,
        remoteHostId: row.remoteHostId ?? null,
        lastTurnEndedAt: row.lastTurnEndedAt ?? null,
        contextTokens: row.contextTokens ?? null,
      },
      {
        hasImages: options.hasImages === true,
        autoResume: options.autoResume === true,
        overrideSelection,
      },
    );

    if (decision.action !== 'switch' || options.signal?.aborted) {
      return { switched: false };
    }

    const targetMakerAgent = dbToMakerAgentKind(decision.target.agentKind);
    let committedModel = decision.target.model;
    let committedProviderId = decision.target.providerId;
    let switched = false;

    const useCrossPath = decision.crossEngine || decision.crossLocation || decision.requiresHandoffForWindow === true;
    if (!useCrossPath) {
      const sameRes = await ports.applySameEngineRoute({
        sessionId,
        model: decision.target.model,
        providerId: decision.target.providerId,
        effort: decision.target.effort ?? row.effort ?? null,
        fastMode: decision.target.fastMode ?? row.fastMode ?? false,
      });
      if (sameRes.contextWindowConfirmationRequired) {
        // 触发窗口缩容确认时自动升级为有界交接，避免阻塞任务发送。
        const crossRes = await ports.performCrossSwitch({
          sessionId,
          targetAgentKind: targetMakerAgent,
          agentDeviceId: decision.target.agentDeviceId,
          model: decision.target.model,
          providerId: decision.target.providerId,
          effort: decision.target.effort,
          fastMode: decision.target.fastMode,
          skipBootstrap: !options.bootstrapAfterSwitch,
        });
        switched = crossRes.switched;
      } else if (!sameRes.deferred && !sameRes.superseded) {
        switched = true;
        committedModel = sameRes.effectiveModelId ?? committedModel;
        if (sameRes.effectiveProviderId) committedProviderId = sameRes.effectiveProviderId;
      }
    } else {
      const crossRes = await ports.performCrossSwitch({
        sessionId,
        targetAgentKind: targetMakerAgent,
        agentDeviceId: decision.target.agentDeviceId,
        model: decision.target.model,
        providerId: decision.target.providerId,
        effort: decision.target.effort,
        fastMode: decision.target.fastMode,
        skipBootstrap: !options.bootstrapAfterSwitch,
      });
      switched = crossRes.switched;
    }

    if (!switched) return { switched: false };

    bindModelGroupSession(
      sessionId,
      decision.selection,
      modelGroupCandidateKey({
        agentKind: makerToDbAgentKind(targetMakerAgent),
        providerId: committedProviderId,
        model: committedModel,
        agentDeviceId: decision.target.agentDeviceId || undefined,
      }),
    );

    if (ports.writeSwitchNote) {
      const reason = ports.describeCause?.(decision.cause) ?? DEFAULT_CAUSE_LABELS[decision.cause];
      const note: ModelGroupRouteNote = {
        pluginName: decision.groupName,
        outcome: 'routed',
        modelName: decision.toLabel,
        ...(decision.target.effort ? { effort: decision.target.effort } : {}),
        reason: `${decision.fromLabel} → ${reason}`,
        source: 'model-group',
      };
      await ports.writeSwitchNote(sessionId, note, `model-group-turn:${sessionId}:${randomUUID()}`).catch((error) => {
        log.warn('model group mid-task switch note failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    log.info('model group mid-task switch applied before send', {
      sessionId,
      cause: decision.cause,
      from: decision.fromLabel,
      to: decision.toLabel,
      crossEngine: decision.crossEngine,
      crossLocation: decision.crossLocation,
    });
    return { switched: true, decision };
  };

  try {
    return ports.runAsOwner ? await ports.runAsOwner(execute) : await execute();
  } catch (error) {
    log.warn('model group pre-send evaluation skipped after error', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { switched: false };
  }
}
