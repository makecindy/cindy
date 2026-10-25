/** Optional local composer enhancement. Uses the existing auxiliary chain directly,
 * without creating an agent turn or emitting agent status events (no recursion).
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import type { Session } from '@cindy/maker-core';
import { isSubagentParentToolUseId } from '@cindy/maker-shared/message-render';
import { isProductTurnDoneEvent, isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import { WORKING_PHASES, isCompactingWorkingStatus, hasPublicWorkingSubject, publicToolPhase, publicToolResultPhase, type WorkingPhase } from '../../shared/workingStatus.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { SUPPORTED_LOCALES } from '../../shared/locale.js';
import { getMakerIfReady } from '../maker-host/index.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { getEffectiveAuxiliaryModelChainSnapshot } from '../utility-model/resolveAuxiliaryModelChain.js';
import { isTerminalTurnErrorEvent } from './sessionTurnActivityTracker.js';
import { MAKER_INVOKE } from './channels.js';
import {createWorkingStatus} from '@cindy/app-runtime/workingStatus';

export const {getWorkingStatusCopy}=createWorkingStatus({activeOwnerScopeKey,isAppSessionBoundaryPending,
 getMakerIfReady,getEffectiveAuxiliaryModelChainSnapshot,SUPPORTED_LOCALES,
 requestUtilityText:(_maker,prompt,options)=>requestUtilityText(getMakerIfReady()!,prompt,options),
});

export function registerWorkingStatusIpc(): void {
  ipcMain.handle(MAKER_INVOKE.WORKING_STATUS, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return getWorkingStatusCopy(raw);
  });
}
