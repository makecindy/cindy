import { randomUUID } from 'node:crypto';
import type { HeadlessHistoryMessage, HeadlessHistoryStorage, HeadlessSessionEventStorage, HeadlessSessionMeta, HeadlessSessionStorageContract } from './session-types.js';
import type { HeadlessSessionRuntime } from './session-runtime.js';
import { HeadlessGitHistory } from './git-history.js';

type HistoryStorage = HeadlessSessionStorageContract & HeadlessSessionEventStorage & HeadlessHistoryStorage;

export type RewindPreview = {
  canRewind: boolean;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  error?: string;
};

/**
 * Linux implementation of Desktop's history domain layer.  The transport sees
 * client ids; this service resolves them to native Claude/Codex anchors and
 * keeps the native transcript and visible history in one safe transaction.
 */
export class HeadlessHistoryService {
  private stopUserMessages: (() => void) | null = null;
  private stopAgentEvents: (() => void) | null = null;
  constructor(
    private readonly storage: HistoryStorage,
    private readonly runtime: HeadlessSessionRuntime,
    private readonly beforeDestructiveChange?: (sessionId: string, reason: string) => Promise<void>,
    private readonly gitHistory?: HeadlessGitHistory,
    private readonly afterHistoryMutation?: () => Promise<void>,
  ) {}

  start(): void {
    if (this.stopUserMessages || !this.gitHistory) return;
    this.stopUserMessages = this.runtime.subscribeUserMessages?.((session, event, origin) => {
      const clientId = stringField(event.data as Record<string, unknown> | null, 'clientId');
      if (origin.kind === 'user' && clientId) return this.gitHistory!.beginTurn(session, clientId);
    }) ?? null;
    this.stopAgentEvents = this.runtime.subscribeAgentEvents?.((sessionId, event) => {
      if (event.type === 'done') void this.gitHistory!.finishTurn(sessionId);
    }) ?? null;
  }

  stop(): void {
    this.stopUserMessages?.(); this.stopUserMessages = null;
    this.stopAgentEvents?.(); this.stopAgentEvents = null;
    this.gitHistory?.close();
  }

  async deleteMessage(sessionId: string, clientId: string): Promise<{ sessionId: string; clientId: string; clientIds: string[] }> {
    const session = await this.requireSession(sessionId);
    this.assertIdle(sessionId);
    await this.beforeDestructiveChange?.(sessionId, 'conversation edited');
    const messages = await this.storage.listHistoryMessages(sessionId);
    const targetIndex = messages.findIndex((message) => message.clientId === clientId);
    if (targetIndex < 0) throw new Error('Message not found or no longer visible');
    const target = messages[targetIndex]!;
    const clientIds = target.role === 'assistant'
      ? messages.slice(findTurnStart(messages, targetIndex) + 1, targetIndex + 1).map((message) => message.clientId)
      : [target.clientId];
    const removed = new Set(clientIds);
    const handoff = buildHandoff(messages.filter((message) => !removed.has(message.clientId)), session);
    await this.runtime.closeSession(sessionId);
    await this.storage.deleteHistoryMessages(sessionId, clientIds, handoff);
    await this.afterHistoryMutation?.();
    await this.storage.appendEvent(sessionId, 'history_deleted', { clientId, clientIds });
    return { sessionId, clientId, clientIds };
  }

  async fork(sessionId: string, clientId: string): Promise<HeadlessSessionMeta> {
    const source = await this.requireSession(sessionId);
    const messages = await this.storage.listHistoryMessages(sessionId);
    const targetIndex = messages.findIndex((message) => message.clientId === clientId);
    if (targetIndex < 0) throw new Error('Message not found or no longer visible');
    const target = messages[targetIndex]!;
    if (target.role !== 'user' && target.role !== 'assistant') throw new Error('Fork is available only on user or assistant messages');
    if (!source.sdkSessionId) throw new Error('Source session has not started; it cannot be forked yet');

    // Forking a user question makes an editable sibling before that question;
    // fork at an assistant keeps the full completed turn.  This mirrors Mac.
    const copyIndex = target.role === 'user' ? targetIndex - 1 : targetIndex;
    const copyBoundary = copyIndex >= 0 ? messages[copyIndex]! : null;
    const priorAssistant = findPriorAssistant(messages, target.role === 'assistant' ? targetIndex : targetIndex - 1);
    const tailTurnsToDrop = messages.slice(copyIndex + 1).filter((message) => message.role === 'user').length;
    const result = await this.requireForkRuntime().forkNativeSession(source.agentKind, {
      sourceSdkSessionId: source.sdkSessionId,
      upToMessageId: priorAssistant?.agentMeta?.uuid,
      tailTurnsToDrop,
      title: forkTitle(source.title),
      workingDir: source.workDir,
    });
    const created = await this.storage.create({
      id: randomUUID(),
      agentKind: source.agentKind,
      providerId: source.providerId,
      workDir: source.workDir,
      title: forkTitle(source.title),
      status: 'active',
      model: source.model,
      workspaceKind: source.workspaceKind,
      effort: source.effort,
      permissionMode: source.permissionMode,
      fastMode: source.fastMode,
      sdkSessionId: result.newSdkSessionId,
      parentSessionId: source.id,
      extraDirs: source.extraDirs,
    });
    await this.storage.forkHistoryMessages(source.id, created.id, copyBoundary?.clientId ?? null, result.uuidMap);
    await this.storage.appendEvent(created.id, 'session_created', { session: created, origin: { kind: 'fork', sourceSessionId: source.id, clientId } });
    return created;
  }

  async previewRewind(sessionId: string, clientId: string): Promise<RewindPreview> {
    const { session, target, messages, targetIndex } = await this.rewindTarget(sessionId, clientId);
    if (session.agentKind === 'codex') {
      return this.gitHistory?.preview(session, target.clientId, messages.filter((message) => message.role === 'user').map((message) => message.clientId)) ?? emptyPreview();
    }
    const userUuid = resolveClaudeUserAnchor(target, messages, targetIndex);
    // Historical Headless rows may predate the user UUID projection.  Desktop
    // uses the same safe conversation-only fallback for legacy messages.
    if (!userUuid) return emptyPreview();
    return this.requireRewindRuntime().previewNativeRewind(session, userUuid);
  }

  async commitRewind(sessionId: string, clientId: string): Promise<HeadlessSessionMeta> {
    const { session, target, messages, targetIndex } = await this.rewindTarget(sessionId, clientId);
    this.assertIdle(sessionId);
    await this.beforeDestructiveChange?.(sessionId, 'conversation rewound');
    const native = this.requireRewindRuntime();
    let nativeResult: { sdkSessionId?: string } = {};
    if (session.agentKind === 'codex') {
      const tailTurnsToDrop = messages.slice(targetIndex).filter((message) => message.role === 'user').length;
      const users = messages.filter((message) => message.role === 'user').map((message) => message.clientId);
      let fileRollback: string | null = null;
      try { fileRollback = (await this.gitHistory?.commit(session, target.clientId, users))?.rollbackCommit ?? null; } catch { /* conversation rollback remains safe and available */ }
      try {
        nativeResult = await native.commitNativeRewind(session, '', '', { tailTurnsToDrop }) ?? {};
      } catch (error) {
        await this.gitHistory?.compensate(session, fileRollback).catch(() => undefined);
        throw error;
      }
    } else {
      const prior = findPriorAssistant(messages, targetIndex - 1);
      const assistantUuid = stringField(prior?.agentMeta, 'uuid');
      if (!assistantUuid) throw new Error('A prior assistant anchor is required before this message can be rewound');
      nativeResult = await native.commitNativeRewind(session, resolveClaudeUserAnchor(target, messages, targetIndex) ?? '', assistantUuid) ?? {};
    }
    const clientIds = await this.storage.rewindHistoryMessages(sessionId, target.clientId);
    await this.afterHistoryMutation?.();
    if (nativeResult.sdkSessionId && nativeResult.sdkSessionId !== session.sdkSessionId) {
      await this.storage.update(sessionId, { sdkSessionId: nativeResult.sdkSessionId });
    }
    const updated = await this.storage.get(sessionId);
    if (!updated) throw new Error('Session disappeared while rewinding');
    await this.storage.appendEvent(sessionId, 'history_rewound', { clientId, clientIds });
    return updated;
  }

  private async rewindTarget(sessionId: string, clientId: string) {
    const session = await this.requireSession(sessionId);
    const messages = await this.storage.listHistoryMessages(sessionId);
    const targetIndex = messages.findIndex((message) => message.clientId === clientId);
    if (targetIndex < 0) throw new Error('Message not found or no longer visible');
    const target = messages[targetIndex]!;
    if (target.role !== 'user') throw new Error('Rewind is available only on user messages');
    if (!session.sdkSessionId) throw new Error('Session has not started; it cannot be rewound');
    return { session, messages, target, targetIndex };
  }

  private async requireSession(sessionId: string): Promise<HeadlessSessionMeta> {
    const session = await this.storage.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  private assertIdle(sessionId: string): void {
    if (this.runtime.isSessionBusy(sessionId)) throw new Error('Session is running; stop it before changing history');
  }

  private requireForkRuntime(): Required<Pick<HeadlessSessionRuntime, 'forkNativeSession'>> {
    if (!this.runtime.forkNativeSession) throw new Error('Native fork is unavailable');
    return this.runtime as Required<Pick<HeadlessSessionRuntime, 'forkNativeSession'>>;
  }

  private requireRewindRuntime(): Required<Pick<HeadlessSessionRuntime, 'previewNativeRewind' | 'commitNativeRewind'>> {
    if (!this.runtime.previewNativeRewind || !this.runtime.commitNativeRewind) throw new Error('Native rewind is unavailable');
    return this.runtime as Required<Pick<HeadlessSessionRuntime, 'previewNativeRewind' | 'commitNativeRewind'>>;
  }
}

function findTurnStart(messages: HeadlessHistoryMessage[], at: number): number {
  for (let index = at; index >= 0; index--) if (messages[index]!.role === 'user') return index;
  return -1;
}

function findPriorAssistant(messages: HeadlessHistoryMessage[], at: number): HeadlessHistoryMessage | null {
  for (let index = at; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant' && stringField(message.agentMeta, 'uuid')) return message;
  }
  return null;
}

function stringField(value: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}

/**
 * Claude's SDK only emits native UUID metadata on assistant events.  The
 * assistant's transcript parent is the immediately preceding user UUID, so
 * persistently deriving it here upgrades new Headless conversations from the
 * legacy conversation-only fallback to real `rewindFiles` preview/commit.
 */
function resolveClaudeUserAnchor(
  target: HeadlessHistoryMessage,
  messages: HeadlessHistoryMessage[],
  targetIndex: number,
): string | undefined {
  const direct = stringField(target.agentMeta, 'uuid');
  if (direct) return direct;
  for (let index = targetIndex + 1; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === 'user') break;
    if (message.role !== 'assistant') continue;
    const anchor = stringField(message.agentMeta, 'transcriptParentUuid');
    if (anchor) return anchor;
  }
  return undefined;
}

function forkTitle(title: string): string { return title.startsWith('[Fork]') ? title : `[Fork] ${title}`; }

function emptyPreview(): RewindPreview { return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }; }

function buildHandoff(messages: HeadlessHistoryMessage[], session: HeadlessSessionMeta): string {
  const recent = messages.slice(-24);
  const lines = recent.flatMap((message) => {
    if (message.role === 'user' || message.role === 'assistant') {
      const text = plainText(message.content).slice(0, 2_000);
      return text ? [`[${message.role === 'user' ? '用户' : '助手'}]\n${text}`] : [];
    }
    if (message.role === 'tool_use') return [`[工具]\n${JSON.stringify(message.content).slice(0, 400)}`];
    return [];
  });
  return [
    '[会话上下文重建·内部上下文]',
    `本会话在 Linux 主机上被用户编辑，原生 ${session.agentKind === 'codex' ? 'Codex' : 'Claude'} 上下文已失效。以下仅是编辑后的有效历史；不要提及本段说明，也不要推断未列出的消息。开始工作前以实际工作区状态为准。`,
    '== 有效对话历史 ==',
    lines.join('\n---\n'),
    '== 上下文重建说明结束，以下是用户的新消息 ==',
  ].join('\n\n').slice(0, 16_000);
}

function plainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return typeof record.text === 'string' ? record.text : typeof record.message === 'string' ? record.message : JSON.stringify(value);
  }
  return '';
}
