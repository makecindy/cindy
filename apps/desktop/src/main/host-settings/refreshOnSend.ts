import type { Session } from '@cindy/maker-core';
import { directoryGrantsForRuntime } from '../maker-ipc/extraDirsValidator.js';
import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';
import { HostSettingsError } from './operations.js';

type LiveSession = Pick<Session, 'agentKind' | 'agentDeviceId' | 'remoteHostId' | 'sdkSessionId'
  | 'hostStartupPreferences' | 'getStatus' | 'isTurnRunning' | 'codexUsesProxyInstructions'
  | 'hasLiveBackgroundWork' | 'hasPendingHostOperation'>;

interface PendingResume {
  nativeId: string;
  agentKind: LiveSession['agentKind'];
  preferences: Session['hostStartupPreferences'];
}

interface Dependencies<Owner extends object, Live extends LiveSession> {
  getOwner(): Owner | null;
  getSession(sessionId: string): Live | undefined;
  readPrompt(): Promise<string>;
  readCreateOpts(sessionId: string): Promise<MakerSessionCreateOpts>;
  readExtraDirs(sessionId: string): Promise<string[]>;
  rebuild(input: {
    sessionId: string;
    opts: MakerSessionCreateOpts;
    live: Live | undefined;
    userPrompt: string;
    assertCurrent(): void;
    beforeClose(): Promise<boolean>;
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
    if (!ownerInput && (!previous || live)) return live;
    // Preserve live sessions that cannot safely replace their startup instructions.
    // Normal reopening can pick up the saved value once their history is available.
    if (live && (live.agentKind === 'acp' ||
        (live.agentKind === 'codex' && !live.codexUsesProxyInstructions) ||
        !live.sdkSessionId || live.sdkSessionId === '<pending>')) return live;
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
    const pendingHistory = previous ? await deps.readCreateOpts(sessionId) : undefined;
    assertCanReplace();
    if (previous && (pendingHistory?.resumeSessionId !== previous.nativeId ||
        pendingHistory.agentKind !== previous.agentKind)) {
      pending?.delete(sessionId);
      return live;
    }
    if (!ownerInput) throw new Error('Retry the user message to resume the original Agent history.');

    let latest: string;
    try {
      latest = await deps.readPrompt();
    } catch (error) {
      assertCanReplace();
      if (live && live === active && live.getStatus() === 'active' &&
          error instanceof HostSettingsError && error.code === 'UNREADABLE') return live;
      throw error;
    }
    assertCanReplace();
    if (live && (live.hostStartupPreferences?.userPrompt ?? '') === latest) {
      pending?.delete(sessionId);
      return live;
    }
    if (live?.hasPendingHostOperation()) return live;
    const saved = pendingHistory ?? await deps.readCreateOpts(sessionId);
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
    const extraDirs = await deps.readExtraDirs(sessionId);
    const session = await deps.rebuild({
      sessionId,
      opts: { ...saved, ...preferences, ...directoryGrantsForRuntime(extraDirs), resumeSessionId: nativeId },
      live: active,
      userPrompt: latest,
      assertCurrent,
      beforeClose: async () => {
        assertCanReplace();
        const backgroundWork = await active?.hasLiveBackgroundWork();
        assertCanReplace();
        if (backgroundWork || active?.hasPendingHostOperation()) return false;
        // Keep strict resume on an in-process retry after the original handle closed.
        const resumes = pendingByOwner.get(owner) ?? new Map<string, PendingResume>();
        pendingByOwner.set(owner, resumes);
        resumes.set(sessionId, { nativeId, agentKind: saved.agentKind, preferences });
        return true;
      },
    });
    pendingByOwner.get(owner)?.delete(sessionId);
    return session;
  };
}
