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
import { WorkingStatusCopy, WORKING_STATUS_COPY_INSTRUCTIONS, workingStatusPrompt, validateWorkingStatusCopy } from './workingStatusCopy.js';

const requestSchema = z.object({ sessionId: z.string().min(1).max(200), phase: z.enum(WORKING_PHASES), locale: z.enum(SUPPORTED_LOCALES) }).strict();
type CopyEntry = { generation: number; scope: string; copy: WorkingStatusCopy; dispose: () => void };
// Different controller languages share their own turn cache without cancelling one another.
const copies = new WeakMap<Session, Map<string, CopyEntry>>();

/** Shared read path. Remote callers must first bind the request to a visible teammate's active Session. */
export async function getWorkingStatusCopy(raw: unknown): Promise<{ text: string | null }> {
    const { sessionId, phase, locale } = requestSchema.parse(raw);
    if (!hasPublicWorkingSubject(phase)) return { text: null };
    const maker = getMakerIfReady();
    const session = maker?.getSession(sessionId);
    if (!maker || !session?.isTurnRunning() || isAppSessionBoundaryPending()) return { text: null };
    const generation = session.getTurnGeneration();
    const owner = activeOwnerScopeKey();
    const chain = getEffectiveAuxiliaryModelChainSnapshot();
    const scope = JSON.stringify([owner, chain, locale]);
    let localized = copies.get(session);
    if (!localized) { localized = new Map(); copies.set(session, localized); }
    let entry = localized.get(locale);
    if (entry && (entry.generation !== generation || entry.scope !== scope)) {
      entry.dispose();
      entry = undefined;
    }
    if (!entry) {
      const eligible = () => !isAppSessionBoundaryPending()
        && activeOwnerScopeKey() === owner && getEffectiveAuxiliaryModelChainSnapshot() === chain
        && session.isTurnRunning()
        && session.getTurnGeneration() === generation;
      const copy = new WorkingStatusCopy(async (current, previous, signal) => {
        if (!eligible() || signal.aborted) return null;
        const result = await requestUtilityText(maker, workingStatusPrompt(current, locale, previous), {
          // Use the utility transport's existing timeout, cancellation and routing.
          maxTokens: 96,
          disableReasoning: true,
          reasoningEffort: 'minimal',
          systemPrompt: WORKING_STATUS_COPY_INSTRUCTIONS,
          responseInstructions: 'Return only the short activity caption.',
          signal,
          beforeDispatch: async () => eligible() && !signal.aborted,
          validateResponse: (text) => validateWorkingStatusCopy(text, current) !== null,
        });
        return eligible() && !signal.aborted && result.ok ? validateWorkingStatusCopy(result.text, current) : null;
      });
      const dispose = () => {
        copy.dispose();
        offEvent();
        offStatus();
        if (localized.get(locale)?.copy === copy) localized.delete(locale);
      };
      let feedbackPhase: WorkingPhase | null = phase.startsWith('reviewing-') ? phase : null;
      const toolPhases = new Map<string, WorkingPhase>();
      let lastToolPhase: WorkingPhase = 'processing';
      const offEvent = session.onEvent((e) => {
        if (e.turnScope === 'background'
          || (e.sessionTurnGeneration !== undefined && e.sessionTurnGeneration !== generation)) return;
        const data = e.data && typeof e.data === 'object' ? e.data as Record<string, unknown> : {};
        if (typeof data.parentToolUseId === 'string' && isSubagentParentToolUseId(data.parentToolUseId)) return;
        if (isProductTurnDoneEvent(e) || isTerminalTurnErrorEvent(e)
          || (e.type === 'status' && data.isRunning === false && !isTurnContinuationBoundaryEvent(e))) { dispose(); return; }
        if (e.type === 'status' && isCompactingWorkingStatus(data.status)) { feedbackPhase = null; copy.observe('compacting'); }
        else if (e.type === 'compact_boundary') { feedbackPhase = null; copy.observe('thinking'); }
        else if (e.type === 'interaction_request') copy.observe(null);
        else if (e.type === 'text' && typeof data.text === 'string' && data.text.length > 0) { feedbackPhase = null; copy.observe('replying'); }
        else if (e.type === 'thinking') copy.observe(feedbackPhase && feedbackPhase !== 'processing' ? feedbackPhase : 'thinking');
        else if (e.type === 'tool_use') {
          feedbackPhase = null;
          lastToolPhase = publicToolPhase(data.toolName, data.input);
          if (typeof data.toolUseId === 'string') toolPhases.set(data.toolUseId, lastToolPhase);
          copy.observe(lastToolPhase);
        } else if (e.type === 'tool_result') {
          const toolPhase = typeof data.toolUseId === 'string' ? toolPhases.get(data.toolUseId) : lastToolPhase;
          if (typeof data.toolUseId === 'string') toolPhases.delete(data.toolUseId);
          feedbackPhase = [...toolPhases.values()].at(-1) ?? publicToolResultPhase(toolPhase ?? lastToolPhase);
          copy.observe(feedbackPhase);
        }
      });
      const offStatus = session.onStatusChange((status) => { if (status !== 'active') dispose(); });
      entry = { generation, scope, copy, dispose };
      localized.set(locale, entry);
    }
    return { text: await entry.copy.request(phase) };
}

export function registerWorkingStatusIpc(): void {
  ipcMain.handle(MAKER_INVOKE.WORKING_STATUS, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return getWorkingStatusCopy(raw);
  });
}
