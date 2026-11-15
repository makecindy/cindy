import type { SessionMeta } from '@cindy/maker-core';
import { sanitizeSourceName } from '@cindy/maker-shared/message-source';
import type { GhostAgentTurnRunner, GhostAgentTurnRunResult } from '../cindy-brain/agentSlot.js';

type GhostAgentSendResult =
  | { ok: true; targetSessionId: string; wakeKind: 'created' | 'resumed' | 'already-active' | 'queued' }
  | Extract<GhostAgentTurnRunResult, { ok: false }>;

export interface GhostAgentTurnRunnerDeps {
  readSessionMeta(id: string): Promise<Pick<SessionMeta, 'remoteHostId' | 'agentDeviceId'> | null>;
  admitLocalSession(id: string): Promise<unknown>;
  readPluginName(id: string): string | null | undefined;
  send(params: {
    sourcePlugin: { pluginId: string; name?: string };
    targetSessionId?: string;
    dispatcherSessionId?: string;
    message: string;
    persistedContent: string;
    inheritSourcePermissionMode?: boolean;
    resumeWithStoredPermissionMode?: boolean;
    title?: string;
  }): Promise<GhostAgentSendResult>;
  readLatestAssistant(id: string): Promise<{ clientId: string | null } | undefined>;
  forkSessionAtMessage(sessionId: string, messageId: string): Promise<{ id: string }>;
  broadcastSessionCreated(id: string): void;
}

/** Host runner after the plugin slot has validated the request and click ticket. */
export function createGhostAgentTurnRunner(deps: GhostAgentTurnRunnerDeps): GhostAgentTurnRunner {
  return async (request) => {
    const dispositionForWakeKind = (
      wakeKind: Extract<GhostAgentSendResult, { ok: true }>['wakeKind'],
    ): 'created' | 'resumed' | 'active' | 'queued' => {
      switch (wakeKind) {
        case 'created':
          return 'created';
        case 'resumed':
          return 'resumed';
        case 'already-active':
          return 'active';
        case 'queued':
          return 'queued';
      }
    };

    // This surface acts on the user's task, so keep its own route/permissions.
    // Admission is shared with plugin-owned tasks; their defaults must not replace it.
    try {
      // SSH and remote Agent routes belong to their execution host's catalog.
      // Let the normal send path restore/queue the task and report remote failures.
      const source = await deps.readSessionMeta(request.sourceSessionId);
      if (!source?.remoteHostId && !source?.agentDeviceId) await deps.admitLocalSession(request.sourceSessionId);
    }
    catch (error) { return { ok: false, errorCode: 'MODEL_UNAVAILABLE',
      message: error instanceof Error ? error.message : '任务模型不可用，请在任务中重新选择' }; }

    // agent.run 的真正发送方是插件(来源任务只是它运行的地方):三种模式都盖插件来源。
    const agentRunPluginName = sanitizeSourceName(deps.readPluginName(request.ghostId));
    const agentRunSourcePlugin = {
      pluginId: request.ghostId,
      ...(agentRunPluginName ? { name: agentRunPluginName } : {}),
    };

    if (request.mode === 'new') {
      const result = await deps.send({
        sourcePlugin: agentRunSourcePlugin,
        dispatcherSessionId: request.sourceSessionId,
        message: request.prompt,
        persistedContent: request.persistedContent,
        inheritSourcePermissionMode: true,
        ...(request.title ? { title: request.title } : {}),
      });
      if (!result.ok) return result;
      return {
        ok: true,
        sessionId: result.targetSessionId,
        disposition: dispositionForWakeKind(result.wakeKind),
      };
    }

    if (request.mode === 'continue') {
      const result = await deps.send({
        sourcePlugin: agentRunSourcePlugin,
        targetSessionId: request.sourceSessionId,
        message: request.prompt,
        persistedContent: request.persistedContent,
        // Cold tasks must keep their saved permissions, just like live tasks.
        resumeWithStoredPermissionMode: true,
      });
      if (!result.ok) return result;
      return {
        ok: true,
        sessionId: result.targetSessionId,
        disposition: dispositionForWakeKind(result.wakeKind),
      };
    }

    // fork 必须基于一条已经完成的 assistant 回复。这里固定选择当前有效历史里
    // 最新一条回复，让插件只能表达“从现在这里分叉”，不能偷偷挑更早的消息。
    const latestAssistant = await deps.readLatestAssistant(request.sourceSessionId);
    if (!latestAssistant?.clientId) {
      return {
        ok: false,
        errorCode: 'NO_PRIOR_ASSISTANT',
        message: '原任务还没有可用于分叉的 Agent 回复',
      };
    }

    let forkedSessionId: string;
    try {
      const forked = await deps.forkSessionAtMessage(request.sourceSessionId, latestAssistant.clientId);
      forkedSessionId = forked.id;
      deps.broadcastSessionCreated(forked.id);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'SOURCE_NOT_FOUND' || code === 'MESSAGE_NOT_FOUND') {
        return { ok: false, errorCode: 'NOT_FOUND', message };
      }
      if (code === 'SOURCE_NEVER_RAN' || code === 'NO_PRIOR_ASSISTANT') {
        return { ok: false, errorCode: code, message };
      }
      if (code === 'UNSUPPORTED_HISTORY') {
        return { ok: false, errorCode: 'FORK_UNSUPPORTED_HISTORY', message };
      }
      return { ok: false, errorCode: `FORK_${code ?? 'FAILED'}`, message };
    }

    const sent = await deps.send({
      sourcePlugin: agentRunSourcePlugin,
      targetSessionId: forkedSessionId,
      message: request.prompt,
      persistedContent: request.persistedContent,
      resumeWithStoredPermissionMode: true,
    });
    if (!sent.ok) return sent;
    return { ok: true, sessionId: forkedSessionId, disposition: 'forked' };
  };
}
