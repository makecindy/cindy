import type { Session } from '@cindy/maker-core';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';

type LiveSession = Pick<Session, 'agentKind' | 'agentDeviceId' | 'remoteHostId' | 'sdkSessionId'
  | 'hostStartupPreferences' | 'getStatus' | 'isTurnRunning' | 'codexUsesProxyInstructions'>;

interface PendingResume {
  nativeId: string;
  preferences: Session['hostStartupPreferences'];
}

interface Dependencies<Owner extends object, Live extends LiveSession> {
  getOwner(): Owner | null;
  getSession(sessionId: string): Live | undefined;
  readPrompt(): Promise<string>;
  readCreateOpts(sessionId: string): Promise<MakerSessionCreateOpts>;
  rebuild(input: {
    sessionId: string;
    opts: MakerSessionCreateOpts;
    live: Live | undefined;
    userPrompt: string;
    assertCurrent(): void;
    beforeClose(): void;
  }): Promise<Live>;
}

/** Called under the task's send lock before the owner input crosses provider dispatch. */
export function createPersonalizationRefresh<Owner extends object, Live extends LiveSession>(
  deps: Dependencies<Owner, Live>,
) {
  const pendingByOwner = new WeakMap<Owner, Map<string, PendingResume>>();

  return async function refresh(
    sessionId: string, live: Live | undefined, ownerInput: boolean, assertInputCurrent: () => void,
  ): Promise<Live | undefined> {
    const owner = deps.getOwner();
    if (!owner) return live;
    const pending = pendingByOwner.get(owner);
    const previous = pending?.get(sessionId);
    if (!ownerInput) {
      if (previous && !live) throw new Error('Retry the user message to resume the original Agent history.');
      return live;
    }
    if (!previous && (!live?.hostStartupPreferences || live.remoteHostId || live.agentDeviceId ||
        live.getStatus() !== 'active')) return live;

    const active = deps.getSession(sessionId);
    const assertCurrent = () => {
      assertInputCurrent();
      if (owner !== deps.getOwner()) throw new Error('The account changed before updating personal instructions.');
    };
    const assertCanReplace = () => {
      assertCurrent();
      if (deps.getSession(sessionId) !== active || active?.isTurnRunning()) {
        throw new Error('The Agent changed before personal instructions could be updated.');
      }
    };

    assertCanReplace();
    const latest = await deps.readPrompt();
    assertCanReplace();
    if (live && (live.hostStartupPreferences?.userPrompt ?? '') === latest) {
      pending?.delete(sessionId);
      return live;
    }
    if (live && live.agentKind !== 'claude-code' && live.agentKind !== 'pi' && !live.codexUsesProxyInstructions) {
      throw new Error('This engine cannot apply changed personal instructions while preserving the current history.');
    }
    const saved = await deps.readCreateOpts(sessionId);
    assertCanReplace();
    const nativeId = previous?.nativeId ?? live?.sdkSessionId;
    if (!nativeId || saved.resumeSessionId !== nativeId || saved.remoteHostId || saved.agentDeviceId ||
        (saved.agentKind !== 'claude-code' && saved.agentKind !== 'pi' && saved.agentKind !== 'codex')) {
      throw new Error('The original Agent history is unavailable for updating personal instructions.');
    }
    if (live && saved.agentKind !== live.agentKind) {
      throw new Error('The selected engine changed before personal instructions could be updated.');
    }
    const preferences = live?.hostStartupPreferences ?? previous?.preferences;
    const session = await deps.rebuild({
      sessionId,
      opts: { ...saved, ...preferences, resumeSessionId: nativeId },
      live: active,
      userPrompt: latest,
      assertCurrent,
      beforeClose: () => {
        assertCanReplace();
        // Keep strict resume on an in-process retry after the original handle closed.
        const resumes = pendingByOwner.get(owner) ?? new Map<string, PendingResume>();
        pendingByOwner.set(owner, resumes);
        resumes.set(sessionId, { nativeId, preferences });
      },
    });
    pendingByOwner.get(owner)?.delete(sessionId);
    return session;
  };
}
