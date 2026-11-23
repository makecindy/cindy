/**
 * Comment wakes from the Open Artifact daemon → the task they belong to.
 *
 * Follows docs/integrating/wake.md of Open Artifact: only the owner's own words (`source.from.kind === 'owner'`)
 * become a user turn. A collaborator's comment or a system notice is outside text: Cindy answers `failed`, so the
 * daemon keeps it in the session's inbox and hands it to the agent with the next tool call's `messages` (tool output,
 * never the user role).
 *
 * Attribution (docs/product-rules/message-source.md): the message reuses `sourcePlugin` with the reserved
 * `local-app:` prefix, so the desktop and mobile labels and the model's `[消息来源]` note say it came from the local
 * app "Open Artifact". No new `origin` kind.
 */
import { randomUUID } from 'node:crypto';
import type { WakeAnswer } from '@open-artifact/harness-kit';
import type { WakeDeliverParams } from '@open-artifact/protocol';
import { createLogger } from '../logger.js';

const log = createLogger('open-artifact');

export const OPEN_ARTIFACT_SOURCE = { pluginId: 'local-app:open-artifact', name: 'Open Artifact' } as const;

/** The subset of `sendToSessionInternal` (maker-ipc/register.ts) a wake uses; register.ts injects the real one. */
export interface WakeSendParams {
  targetSessionId: string;
  message: string;
  clientId: string;
  forceQueue: true;
  resumeWithStoredPermissionMode: true;
  sourcePlugin: { pluginId: string; name: string };
}
export type WakeSendResult =
  | { ok: true; wakeKind: string }
  | { ok: false; errorCode: string; message?: string };

export interface WakeDeps {
  send: (params: WakeSendParams) => Promise<WakeSendResult>;
  /** True when a new user turn would wait (a turn is running or an interaction is pending). */
  isBusy: (sessionId: string) => boolean;
}

export function createWakeHandler(deps: WakeDeps): (params: WakeDeliverParams) => Promise<WakeAnswer> {
  return async (params) => {
    const session = params.session;
    if (!session) return 'failed';
    if (params.source?.from?.kind !== 'owner') {
      // A notice, not the person's words: it stays in the inbox and reaches the agent as tool output.
      log.info('Open Artifact notice left for the next tool call', { reason: params.source?.reason, from: params.source?.from?.kind });
      return 'failed';
    }
    const busy = deps.isBusy(session);
    try {
      // forceQueue: the durable input queue starts the turn when the task is idle and runs it next when busy,
      // the same path a plugin's message takes. The stored permission mode applies when the task is resumed.
      const result = await deps.send({
        targetSessionId: session,
        message: params.text,
        clientId: `open-artifact-${randomUUID()}`,
        forceQueue: true,
        resumeWithStoredPermissionMode: true,
        sourcePlugin: { ...OPEN_ARTIFACT_SOURCE },
      });
      if (!result.ok) {
        log.warn('Open Artifact comment not delivered', { code: result.errorCode });
        return 'failed';
      }
      return busy ? 'queued' : 'resumed';
    } catch (error) {
      log.warn('Open Artifact comment not delivered', { error: (error as Error).message });
      return 'failed';
    }
  };
}
