import {
  getModerationIdentity,
  isModerationIdentityCurrent,
} from './identity.js';
import { emitOutputModerationSignal } from './signals.js';
import {
  StreamModerationClient,
  type StreamModerationCallbacks,
} from './streamClient.js';

const STARTUP_TIMEOUT_MS = 5_000;

export async function reviewPostProcessedOutput(
  sessionId: string,
  turnId: string,
  text: string,
): Promise<boolean> {
  const identity = getModerationIdentity();
  if (!identity || text.length === 0) return true;

  return new Promise<boolean>((resolve) => {
    const startupAbort = new AbortController();
    let stream: StreamModerationClient | null = null;
    let settled = false;
    const settle = (allowed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (!isModerationIdentityCurrent(identity)) {
        stream?.cancel();
        resolve(false);
        return;
      }
      resolve(allowed);
    };
    const callbacks: StreamModerationCallbacks = {
      onRelease: () => undefined,
      onBlock: () => {
        emitOutputModerationSignal({ sessionId, turnId, kind: 'blocked' });
        settle(false);
      },
      onFailed: () => settle(false),
      onCompleted: () => settle(true),
      onFailOpen: () => settle(true),
    };
    const startupTimer = setTimeout(() => {
      startupAbort.abort();
      stream?.cancel();
      settle(true);
    }, STARTUP_TIMEOUT_MS);

    void StreamModerationClient.create({
      signBaseUrl: identity.signBaseUrl,
      accessToken: identity.accessToken,
      membershipId: identity.membershipId,
      sessionId,
      turnId,
      agentKind: 'ghost',
      signal: startupAbort.signal,
    }, callbacks).then((created) => {
      stream = created;
      if (settled) {
        created?.cancel();
        return;
      }
      if (!created) {
        settle(true);
        return;
      }
      created.push(text);
      created.finish();
    }).catch(() => settle(true));
  });
}
