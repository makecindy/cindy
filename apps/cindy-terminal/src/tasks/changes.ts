import { randomUUID } from 'node:crypto';
import type { AgentEvent, Logger, Session } from '@cindy/maker-core';
import { createTurnChangeSetStore, TurnChangeSetActionError } from '@cindy/remote-agent/host/turn-change-set/store';
import type { TurnChangeAction } from '@cindy/remote-agent/host/turn-change-set/turnChangeSet';
import type { TerminalTaskStorage } from './storage.js';

export const TASK_CHANGE_CHANNELS = ['maker:turn-change-sets:list', 'maker:turn-change-sets:get', 'maker:turn-change-set:apply'] as const;

/** Desktop-compatible turn patches, owned by this account's task host. */
export class TerminalTaskChanges {
  readonly store;
  private readonly actions = new Set<string>();
  constructor(private readonly host: {
    profileDir: string;
    storage: TerminalTaskStorage;
    logger: Logger;
    assertCurrent(): void;
    activeWorkspaces(): string[];
    userMessageIds(sessionId: string): Promise<Set<string>>;
    emit(channel: string, payload: unknown): void;
  }) {
    this.store = createTurnChangeSetStore({
      userDataPath: () => host.profileDir, createId: randomUUID, log: host.logger,
      captureOwnerScope: () => this,
      isOwnerScopeCurrent: scope => { try { host.assertCurrent(); return scope === this; } catch { return false; } },
      broadcastUpdated: payload => host.emit('maker:turn-change-set:updated', payload),
      readWorkspace: async id => { const row = await host.storage.get(id); return row ? { workingDir: row.workDir, remoteHostId: null } : null; },
      validAnchorIds: async (id, ids) => {
        if (!await host.storage.get(id)) return new Set<string>();
        const current = await host.userMessageIds(id);
        return new Set(ids.filter(key => current.has(key)));
      },
    });
  }
  assertCanDispatch(workDir: string) {
    this.host.assertCurrent();
    if (this.actions.has(this.store.normalizeTurnChangeSetWorkspaceKey(workDir))) throw new Error('WORKSPACE_RESTORE_RUNNING');
  }
  readonly capture = {
    beforeKnownFileWrite: async (input: Parameters<typeof this.store.captureKnownFileBefore>[0]) => {
      this.assertCanDispatch(input.cwd);
      await this.store.captureKnownFileBefore(input);
      this.host.assertCurrent();
    },
    noteOpaqueWrite: (input: Parameters<typeof this.store.noteOpaqueTurnChange>[0]) => {
      this.assertCanDispatch(input.cwd);
      this.store.noteOpaqueTurnChange(input);
    },
  };
  async begin(session: Session, anchorClientId: string) {
    this.assertCanDispatch(session.workDir);
    await this.store.waitForTurnChangeSetSeal(session.id);
    await this.store.finalizeTurnChangeSet(session.id, null, 'partial');
    await this.store.waitForTurnChangeSetSeal(session.id);
    this.assertCanDispatch(session.workDir);
    await this.store.beginTurnChangeSet({ sessionId: session.id, anchorClientId, provider: session.agentKind, cwd: session.workDir, remote: session.remoteHostId !== null });
  }
  observe(session: Session, event: AgentEvent) {
    if (event.turnScope === 'background') return;
    this.store.noteTurnDiffEvent(session.id, event, session.remoteHostId !== null);
    const data = event.data as { silentStop?: boolean; isTerminal?: boolean; turnId?: string } | undefined;
    if (event.type === 'done' && !data?.silentStop || event.type === 'error' && data?.isTerminal !== false) {
      void this.store.finalizeTurnChangeSet(session.id, data?.turnId ?? null, event.type === 'done' ? 'complete' : 'partial')
        .catch(() => this.host.logger.warn('Task change record could not be saved'));
    }
  }
  async apply(sessionId: string, id: string, action: TurnChangeAction, assertAccess: () => void) {
    this.host.assertCurrent(); assertAccess();
    const row = await this.host.storage.get(sessionId);
    if (!row) throw new Error('TASK_NOT_FOUND');
    const key = this.store.normalizeTurnChangeSetWorkspaceKey(row.workDir);
    const assertIdle = () => {
      this.host.assertCurrent(); assertAccess();
      if (this.host.activeWorkspaces().some(dir => this.store.normalizeTurnChangeSetWorkspaceKey(dir) === key)) throw new Error('SESSION_RUNNING');
    };
    if (this.actions.has(key)) throw new Error('WORKSPACE_RESTORE_RUNNING');
    assertIdle(); this.actions.add(key);
    try {
      await this.store.waitForTurnChangeSetSeal(sessionId); assertIdle();
      return await this.store.applyTurnChangeSetAction(sessionId, id, action, this, async () => assertIdle());
    } catch (error) {
      if (!(error instanceof TurnChangeSetActionError)) throw error;
      const code = { 'not-found': 'NOT_FOUND', busy: 'SESSION_RUNNING', 'wrong-state': 'PRECONDITION_FAILED', 'git-missing': 'TURN_CHANGE_GIT_UNAVAILABLE', unsupported: 'UNSUPPORTED_CAPABILITY', conflict: 'STALE_DIFF', 'apply-failed': 'INTERNAL' }[error.kind];
      throw new Error(code, { cause: error });
    } finally { this.actions.delete(key); }
  }
  async close() {
    await this.store.waitForTurnChangeSetActions();
    await this.store.waitForTurnChangeSetPersistence();
  }
}
