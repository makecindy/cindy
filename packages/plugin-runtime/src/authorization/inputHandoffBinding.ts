import { randomBytes } from 'node:crypto';
import { INPUT_HANDOFF_ACTION_ID, INPUT_HANDOFF_GHOST_ID, inputHandoffPresentation, type PluginOauthAction, type InputHandoffSubmission } from '@cindy/device-link';
import type { InputHandoffService } from '@cindy/remote-agent/input-handoff/service';
import type { OauthCardBinding } from './transactions.js';
import { getRemoteOauthContext } from './context.js';

export function createInputHandoffAuthorization(getService: () => InputHandoffService | null | undefined) {
  // 代输入: one signed exchange per step, bound to the exact pending revision.
  const findHandoffStep = (action: PluginOauthAction) => {
    const service = getService();
    if (!service || action.actionId !== INPUT_HANDOFF_ACTION_ID) return null;
    const snapshot = service.actionable(action.requestId, action.expectedRevision);
    if (!snapshot) return null;
    const binding: OauthCardBinding = {
      ghostId: INPUT_HANDOFF_GHOST_ID,
      // A newer step is rejected by the revision check on submit. The exchange
      // stays valid while the handoff runs, and after an answer that completed
      // it (a terminal password, a last sign-in step) so it can report success;
      // a cancelled, timed-out or failed handoff is no longer current.
      current: () => service.isCurrent(action.requestId) || service.succeeded(action.requestId),
    };
    return { service, snapshot, binding };
  };
  const runHandoffStep = (action: PluginOauthAction): boolean => {
    const step = findHandoffStep(action);
    const remote = getRemoteOauthContext();
    if (!step || !remote?.submitInput) return false;
    const presentation = inputHandoffPresentation(step.snapshot);
    // A screenshot step travels only inside this sealed offer, to the device that asked for it.
    const picture = presentation.picture
      ? step.service.picture(action.requestId, action.expectedRevision)
      : null;
    if (presentation.picture && !picture) return false;
    void (async () => {
      let submission: InputHandoffSubmission | undefined;
      try {
        submission = await remote.submitInput!({
          kind: 'input-entry',
          state: randomBytes(32).toString('base64url'),
          presentation,
          ...(picture ? { picture } : {}),
        });
        remote.assertCurrent();
        if (submission.expectedRevision !== action.expectedRevision)
          throw new Error('INPUT_HANDOFF_STALE');
        const accepted = await step.service.submit(
          action.requestId,
          submission,
          remote.peer ? { deviceId: remote.peer } : undefined,
        );
        remote.finish(accepted);
      } catch {
        remote.finish(false);
      } finally {
        submission = undefined;
      }
    })();
    return true;
  };
  return { find: findHandoffStep, run: runHandoffStep };
}
