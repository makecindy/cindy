import type { AgentKind, Maker } from '@cindy/maker-core';

export interface CodexThreadRotationSnapshot {
  sessionId: string;
  sourceSdkSessionId: string;
  sourceModel: string;
  sourceProviderId: string | null;
  workingDir: string;
}

export interface PreparedCodexThreadRotation {
  newSdkSessionId: string;
  rollback: () => Promise<void>;
}

/**
 * The session binding changed while this rotation was being prepared.  A
 * newer lifecycle (clear, agent switch, or another rotation) owns the
 * session now; retrying this snapshot would keep the input gate open forever.
 */
export class CodexThreadRotationSupersededError extends Error {
  readonly code = 'CODEX_THREAD_ROTATION_SUPERSEDED';

  constructor(sessionId: string) {
    super(`Codex thread rotation was superseded by a newer session binding: ${sessionId}`);
    this.name = 'CodexThreadRotationSupersededError';
  }
}

export function isCodexThreadRotationSupersededError(
  error: unknown,
): error is CodexThreadRotationSupersededError {
  return (
    error instanceof CodexThreadRotationSupersededError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'CODEX_THREAD_ROTATION_SUPERSEDED')
  );
}

export type PrepareCodexThreadRotation = (
  snapshot: CodexThreadRotationSnapshot,
) => Promise<PreparedCodexThreadRotation>;

export function codexThreadRotationSnapshotFromSession(
  session: {
    id: string;
    agentKind: AgentKind;
    remoteHostId?: string | null;
    sdkSessionId?: string | null;
    model: string;
    workDir?: string | null;
  },
  providerId: string | null,
): CodexThreadRotationSnapshot | null {
  const sdkSessionId = session.sdkSessionId;
  const workingDir = session.workDir;
  if (
    session.agentKind !== 'codex' ||
    session.remoteHostId ||
    !sdkSessionId ||
    sdkSessionId === '<pending>' ||
    !workingDir
  ) {
    return null;
  }
  return {
    sessionId: session.id,
    sourceSdkSessionId: sdkSessionId,
    sourceModel: session.model,
    sourceProviderId: providerId,
    workingDir,
  };
}

export function createCodexThreadRotationPreparer(args: {
  maker: Pick<Maker, 'forkSdkSession'>;
  replaceSdkSessionIdIfCurrent: (
    sessionId: string,
    expectedSdkSessionId: string,
    nextSdkSessionId: string,
  ) => Promise<boolean>;
}): PrepareCodexThreadRotation {
  return async (snapshot) => {
    const fork = await args.maker.forkSdkSession('codex', {
      sourceSdkSessionId: snapshot.sourceSdkSessionId,
      model: snapshot.sourceModel,
      providerId: snapshot.sourceProviderId,
      workingDir: snapshot.workingDir,
      upToMessageId: undefined,
      stripEncryptedReasoning: true,
    });
    const applied = await args.replaceSdkSessionIdIfCurrent(
      snapshot.sessionId,
      snapshot.sourceSdkSessionId,
      fork.newSdkSessionId,
    );
    if (!applied) {
      throw new CodexThreadRotationSupersededError(snapshot.sessionId);
    }
    let rolledBack = false;
    return {
      newSdkSessionId: fork.newSdkSessionId,
      rollback: async () => {
        if (rolledBack) return;
        rolledBack = true;
        const restored = await args.replaceSdkSessionIdIfCurrent(
          snapshot.sessionId,
          fork.newSdkSessionId,
          snapshot.sourceSdkSessionId,
        );
        if (!restored) {
          throw new Error(
            `Codex thread rotation rollback lost its session binding: ${snapshot.sessionId}`,
          );
        }
      },
    };
  };
}
