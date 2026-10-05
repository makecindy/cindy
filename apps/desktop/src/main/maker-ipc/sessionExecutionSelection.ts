import type { AgentKind, Effort } from '@cindy/maker-core';
import { resolveSendToSessionExecutionConfig, type SendToSessionExecutionConfig } from './sendToSessionExecutionConfig.js';

export type SessionExecutionSelection = SendToSessionExecutionConfig;
export interface SessionModelSelection {
  agentKind?: 'cc' | AgentKind;
  model?: string;
  providerId?: string | null;
  effort?: string;
  fastMode?: boolean;
}
type Selection = SessionModelSelection;
type Admission = Parameters<typeof resolveSendToSessionExecutionConfig>[0];

/** Shared Session model selection. Callers supply authorized defaults; no caller-specific lifecycle or permissions. */
export function resolveSessionExecutionSelection(params: {
  selection: Selection;
  source?: SessionExecutionSelection;
  availableAgents: readonly AgentKind[];
  availableModels: Admission['availableModels'];
  providerRouting: Admission['providerRouting'];
  hasCindyAiApiKey: boolean;
}): SessionExecutionSelection {
  const { selection, source, providerRouting } = params;
  const agentKind = selection.agentKind === 'cc' ? 'claude-code' : selection.agentKind ?? source?.agentKind;
  const model = selection.model ?? source?.model;
  const recover = '请在任务中重新选择模型，或在「设置 → 模型供应商」修复连接后重试。';
  if (!agentKind || !model) throw new Error(`尚未选择任务模型。请先选择新任务模型，或${recover}`);
  if (!params.availableAgents.includes(agentKind)) throw new Error(`Agent ${agentKind} 当前不可用。${recover}`);
  // An old partial override may change engines/models. Never borrow the previous
  // model's provider or tuning; choose only a route for this exact requested model.
  const sameIdentity = source?.agentKind === agentKind && source.model === model;
  const providerId = selection.providerId ?? (sameIdentity ? source?.providerId : undefined)
    ?? providerRouting.resolveDefaultProviderIdForModel(agentKind, model);
  const routeModel = providerRouting.availability[agentKind]?.find(p => p.id === providerId)?.effortMetaByModel?.[model];
  const metadata = routeModel ?? params.availableModels.find(m => m.id === model);
  const defaultEffort = metadata?.defaultEffort;
  const effort = selection.effort ?? (sameIdentity ? source?.effort : undefined)
    ?? (defaultEffort && metadata?.efforts?.includes(defaultEffort) ? defaultEffort : undefined);
  const candidate: SessionExecutionSelection = {
    agentKind, model, providerId, effort: (effort || undefined) as Effort | undefined,
    fastMode: selection.fastMode ?? (sameIdentity ? source?.fastMode : false) ?? false,
  };
  const result = resolveSendToSessionExecutionConfig({
    source: candidate, overrides: { effort: candidate.effort, fastMode: candidate.fastMode },
    availableModels: params.availableModels, providerRouting, hasCindyAiApiKey: params.hasCindyAiApiKey,
  });
  if (!result.ok) throw new Error(`${result.message} ${recover}不会自动更换模型或供应商。`);
  return result.config;
}

export interface SessionExecutionResolverDeps {
  captureOwner(): () => void;
  readCaller(sessionId: string): Promise<SessionExecutionSelection>;
  readDefault(): SessionExecutionSelection | undefined;
  availableAgents(): readonly AgentKind[];
  availableModels(agent: AgentKind): Admission['availableModels'];
  readProviderRouting(): Promise<Admission['providerRouting']>;
  hasCindyAiApiKey(): boolean;
}

/** sourceSessionId is Host-resolved from an authenticated call, never plugin-supplied. */
export function createSessionExecutionResolver(deps: SessionExecutionResolverDeps) {
  return async (selection: Selection, sourceSessionId?: string,
    existing?: { agentKind: string; model: string; providerId?: string | null; effort?: string | null; fastMode?: boolean },
  ): Promise<SessionExecutionSelection> => {
    const assertOwner = deps.captureOwner();
    assertOwner();
    let source: SessionExecutionSelection | undefined;
    if (existing) {
      if (!['cc', 'claude-code', 'codex', 'pi'].includes(existing.agentKind)) throw new Error('任务 Agent 不可用，请重新选择模型');
      source = { agentKind: (existing.agentKind === 'cc' ? 'claude-code' : existing.agentKind) as AgentKind,
        model: existing.model, providerId: existing.providerId,
        effort: (existing.effort || undefined) as Effort | undefined, fastMode: existing.fastMode === true };
    } else if (!(selection.agentKind && selection.model && selection.providerId)) {
      source = sourceSessionId ? await deps.readCaller(sourceSessionId) : deps.readDefault();
      assertOwner();
    }
    const providerRouting = await deps.readProviderRouting();
    assertOwner();
    const agent = selection.agentKind === 'cc' ? 'claude-code' : selection.agentKind ?? source?.agentKind;
    return resolveSessionExecutionSelection({ selection, source, providerRouting,
      availableAgents: deps.availableAgents(), availableModels: agent ? deps.availableModels(agent) : [],
      hasCindyAiApiKey: deps.hasCindyAiApiKey() });
  };
}
