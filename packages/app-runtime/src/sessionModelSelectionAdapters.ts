import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import type { MakerSessionAgentSwitchHandlerDeps } from '@cindy/im-runtime/sessionAgentSwitch';
import type { PendingCredentialSwitchDeps } from './pendingCredentialSwitch.js';
import type { SessionRuntimeProfile } from './sessionRuntimeControl.js';
import type { ApplySessionRuntimeSelection } from './sessionRuntimeSelectionTypes.js';
import type { createSessionModelSelection } from './sessionModelSelection.js';

export function createSameAgentModelSelection(applySessionRuntimeSelection: ApplySessionRuntimeSelection): NonNullable<MakerSessionAgentSwitchHandlerDeps['selectSameAgentModel']> {
 return async (sessionId, intent, applyNow, assertSelectionCurrent, beforeMutation) => {
      const result = await applySessionRuntimeSelection(sessionId, intent.model, intent.providerId, {
        effort: (intent.effort ?? null) as SessionRuntimeProfile['effort'],
        fastMode: intent.fastMode ?? false,
        ...(intent.thinking !== undefined ? { thinking: intent.thinking } : {}),
        // 只有 Agent 在另一台电脑运行的任务会在意图里带确认过的目标窗口。
        // Preserve the exact window acknowledged by the picker until send.
        ...(intent.confirmedContextWindow ? { confirmedContextWindow: intent.confirmedContextWindow } : {}),
      }, { source: 'user', sessionLockHeld: true, applyingUserSelectionOnSend: applyNow,
        runtimeSource: intent.runtimeSource, configStaged: intent.configStaged === true,
        assertSelectionCurrent, beforeMutation });
      if (result.contextWindowConfirmationRequired !== undefined) {
        throwIpcError('PRECONDITION_FAILED', 'Model context window changed or was unknown; select the model again to confirm');
      }
      return result;
    };
}

export function createPendingPiModelSelection(handleSetModel: ReturnType<typeof createSessionModelSelection>, sessionRuntimeControlOwnerEpochMatches: (epoch: string) => boolean): NonNullable<PendingCredentialSwitchDeps['applyPiPending']> {
 return async (sessionId, target, resolved, isCurrent) => {
    const assertPendingCurrent = () => {
      if (!isCurrent() || !target.ownerEpoch ||
          !sessionRuntimeControlOwnerEpochMatches(target.ownerEpoch)) {
        throw new Error('Pi pending model switch was superseded or its account changed');
      }
    };
    assertPendingCurrent();
    const result = await handleSetModel(sessionId, resolved.model, resolved.providerId,
      undefined, undefined, {
        source: target.selectionSource ?? 'user', applyingUserSelectionOnSend: true,
        applyingPiCredentialPending: true, refreshPiConfiguration: true,
        ...(target.previousRoute ? { previousPiRoute: target.previousRoute } : {}),
        assertSelectionCurrent: assertPendingCurrent,
      });
    if (result.superseded) throw new Error('Pi pending model switch was superseded');
    if (result.contextWindowConfirmationRequired) {
      throw new Error('Pi model switch needs confirmation for its smaller context window');
    }
    return result.deferred ? 'deferred' : 'applied';
  };
}
