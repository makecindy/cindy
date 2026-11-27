import { and, eq } from 'drizzle-orm';
import type { AgentKind, Maker } from '@cindy/maker-core';
import { DEFAULT_DRAFT_SESSION_TITLE, normalizeAutoTitle } from '@cindy/maker-shared/session-title';
import { dbToMakerAgentKind } from '../../../desktop/src/shared/agentKindConversion.js';
import { deriveAutoTitleSeed, type AgentInputQueuedMessage } from '../../../desktop/src/shared/agentInputQueue.js';
import { resolveSystemLocale, type SupportedLocale } from '../../../desktop/src/shared/locale.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { isDeviceLinkInvoke } from '../../../desktop/src/main/device-link/invoke-context.js';
import { getCurrentDbClientSnapshot, getDbClient } from '../../../desktop/src/main/localDb/client/current.js';
import { regenerateTitleMaterial } from '../../../desktop/src/main/localDb/latestMessageText.js';
import { sessions as sessionTable } from '../../../desktop/src/main/localDb/schema.js';
import { createAuxiliaryTitleOneShotCore } from '../../../desktop/src/main/maker-host/auxiliaryTitleOneShotCore.js';
import {
  createSessionAutoTitleCore,
  type OverwritableAutoTitleTarget,
  type SessionAutoTitleDeps,
} from '../../../desktop/src/main/maker-ipc/sessionAutoTitleCore.js';
import { buildAutoTitlePrompt } from '../../../desktop/src/main/maker-ipc/title-prompt.js';
import {
  AUTO_TITLE_MESSAGE_SLICE,
  parseGenerateTitleRequest,
  parseRegenerateTitleRequest,
  readSessionAgentKindFromDb,
  regenerateMakerSessionTitleCore,
} from '../../../desktop/src/main/maker-ipc/titleCore.js';
import { uiText } from '../../../desktop/src/main/uiText.js';
import { holdError } from './profile-hold.js';
import type { createHostAutoReview } from './auto-review.js';

const FORK_PLACEHOLDER_TITLE_PREFIX = '[Fork';

export interface HostAutoTitleDeps {
  getAutoReview(): ReturnType<typeof createHostAutoReview> | null;
  getMaker(): Maker | null;
  profileHoldReason(): string | null;
  profileHoldGeneration?(): number;
  hasEnabledUserMessageHookGhost(): boolean;
  drainHistories(): Promise<void>;
  isSessionTurnPendingCompletion(sessionId: string): boolean;
  publish(event: Record<string, unknown>): void;
  resolveLocale?(): SupportedLocale;
}

export function createHostAutoTitle(deps: HostAutoTitleDeps) {
  const resolveLocale: () => SupportedLocale =
    deps.resolveLocale ?? (() => resolveSystemLocale(Intl.DateTimeFormat().resolvedOptions().locale));
  const holdGeneration = () => deps.profileHoldGeneration?.() ?? 0;
  const canWrite = () => !deps.profileHoldReason() && !isAppSessionBoundaryPending();
  const isRunCurrent = (startGen: number) => canWrite() && holdGeneration() === startGen;

  function assertNotHeld(): void {
    const held = deps.profileHoldReason();
    if (held) throw holdError(held);
  }

  function makeOneShotCore(startGen: number) {
    const review = deps.getAutoReview();
    const maker = deps.getMaker();
    if (!review || !maker) return null;
    return createAuxiliaryTitleOneShotCore({
      readModels: () => review.settings.readAuxiliaryModelSettings().models,
      readOwnerScope: () => activeOwnerScopeKey(),
      getEffectiveAuxiliaryModelChain: () => review.chain.getEffectiveAuxiliaryModelChain(),
      getEffectiveAuxiliaryModelChainSnapshot: () => review.chain.getEffectiveAuxiliaryModelChainSnapshot(),
      agentSupportsOneShot: agentKind => review.oneShot.agentSupportsOneShot(agentKind),
      isAgentOneShotRouteDisabled: (agentKind, model) => review.isOneShotRouteDisabled(agentKind, model),
      getMaker: () => maker,
      requestText: (prompt, opts) => review.oneShot.requestUtilityText(maker, prompt, opts),
      isDispatchAllowed: () => isRunCurrent(startGen),
    });
  }

  async function resolveOverwritableTitle(
    sessionId: string,
    synthesizedPlaceholder?: string | null,
  ): Promise<OverwritableAutoTitleTarget | null> {
    const [row] = await getDbClient()
      .drizzle.select({
        title: sessionTable.title,
        agentKind: sessionTable.agentKind,
        parentSessionId: sessionTable.parentSessionId,
      })
      .from(sessionTable)
      .where(eq(sessionTable.id, sessionId))
      .limit(1);
    if (!row) return null;
    const overwritable =
      row.title === DEFAULT_DRAFT_SESSION_TITLE ||
      (!!row.parentSessionId && row.title.startsWith(FORK_PLACEHOLDER_TITLE_PREFIX)) ||
      (!!synthesizedPlaceholder && row.title === synthesizedPlaceholder);
    if (!overwritable) return null;
    return {
      title: row.title,
      agentKind: row.agentKind === 'acp' ? null : dbToMakerAgentKind(row.agentKind),
      isDefaultDraftTitle: row.title === DEFAULT_DRAFT_SESSION_TITLE,
    };
  }

  async function persistTitle(
    sessionId: string,
    title: string,
    expectedTitle: string = DEFAULT_DRAFT_SESSION_TITLE,
    startGen: number = holdGeneration(),
  ): Promise<boolean> {
    const owner = getCurrentDbClientSnapshot();
    const stillCurrent = () =>
      owner !== null &&
      getCurrentDbClientSnapshot() === owner &&
      isRunCurrent(startGen);
    if (!stillCurrent()) return false;
    const cleanTitle = normalizeAutoTitle(title);
    if (!cleanTitle || cleanTitle === DEFAULT_DRAFT_SESSION_TITLE) return false;
    const db = getDbClient().drizzle;
    if (cleanTitle === expectedTitle) {
      const [current] = await db
        .select({ title: sessionTable.title })
        .from(sessionTable)
        .where(eq(sessionTable.id, sessionId))
        .limit(1);
      return stillCurrent() && !!current && current.title === cleanTitle;
    }
    if (!stillCurrent()) return false;
    await db
      .update(sessionTable)
      .set({ title: cleanTitle })
      .where(and(eq(sessionTable.id, sessionId), eq(sessionTable.title, expectedTitle)));
    const [after] = await db
      .select({ title: sessionTable.title })
      .from(sessionTable)
      .where(eq(sessionTable.id, sessionId))
      .limit(1);
    if (!after || after.title !== cleanTitle) return false;
    if (stillCurrent()) {
      deps.publish({ type: 'session_changed', sessionId, patch: { title: cleanTitle } });
    }
    return true;
  }

  async function generateMakerSessionTitle(
    message: string,
    agentKind: AgentKind | null,
    sessionId?: string,
    startGen: number = holdGeneration(),
  ): Promise<string | null> {
    const trimmed = message.trim();
    if (!trimmed || !isRunCurrent(startGen)) return null;
    const oneShot = makeOneShotCore(startGen);
    if (!oneShot) return null;
    return oneShot.generateTitleWithAuxiliaryModel({
      sessionId: sessionId ?? '',
      agentKind,
      prompt: buildAutoTitlePrompt(trimmed.slice(0, AUTO_TITLE_MESSAGE_SLICE), resolveLocale()),
    });
  }

  function scopedAutoTitleDeps(startGen: number): SessionAutoTitleDeps {
    return {
      resolveOverwritableTitle: async (sessionId, synthesizedPlaceholder) => {
        if (!isRunCurrent(startGen)) return null;
        return resolveOverwritableTitle(sessionId, synthesizedPlaceholder);
      },
      generateTitle: (message, agentKind, sessionId) =>
        generateMakerSessionTitle(message, agentKind, sessionId, startGen),
      persistTitle: (sessionId, title, expectedTitle) =>
        persistTitle(sessionId, title, expectedTitle, startGen),
    };
  }

  const core = createSessionAutoTitleCore({
    getDefaultDeps: () => scopedAutoTitleDeps(holdGeneration()),
    isUntitledSessionAwaitingAutoTitle: async (sessionId, synthesizedPlaceholder) =>
      (await resolveOverwritableTitle(sessionId, synthesizedPlaceholder)) !== null,
    canWrite,
  });
  core.setUserMessageScreeningProbe(() => deps.hasEnabledUserMessageHookGhost());

  return {
    markManuallyRenamed(sessionId: string): void {
      core.markSessionManuallyRenamed(sessionId, getCurrentDbClientSnapshot());
    },
    prepareDeviceLinkAutoTitle(
      sessionId: string,
      queued: AgentInputQueuedMessage,
    ): () => void {
      const noop = () => {};
      if (!isDeviceLinkInvoke()) return noop;
      const seed = deriveAutoTitleSeed(queued, {
        image: uiText('ccAgent.autoTitle.image', 'Image'),
        file: uiText('ccAgent.autoTitle.file', 'File'),
      });
      if (!seed) return noop;
      const rawAgentKind = queued.createOpts?.agentKind;
      const agentKind: AgentKind | null =
        rawAgentKind === 'acp' ? null : (rawAgentKind ?? 'claude-code');
      return () => {
        if (!canWrite()) return;
        const startGen = holdGeneration();
        core.scheduleSessionAutoTitle(
          { sessionId, text: seed.text, agentKind, isUserText: seed.isUserText },
          scopedAutoTitleDeps(startGen),
        );
      };
    },
    async runAutoTitle(input: { sessionId?: unknown; text?: unknown; isUserText?: unknown; agentKind?: unknown }) {
      const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : '';
      const text = typeof input?.text === 'string' ? input.text : '';
      if (!sessionId || !text.trim() || !canWrite()) return { applied: false, done: false };
      if (deps.hasEnabledUserMessageHookGhost()) return { applied: false, done: false };
      const startGen = holdGeneration();
      const agentKind: AgentKind =
        input.agentKind === 'codex' || input.agentKind === 'pi' ? input.agentKind : 'claude-code';
      return core.runSessionAutoTitle(
        {
          sessionId,
          text,
          agentKind,
          ...(typeof input.isUserText === 'boolean' ? { isUserText: input.isUserText } : {}),
        },
        scopedAutoTitleDeps(startGen),
      );
    },
    async generateTitle(rawRequest: unknown): Promise<{ title: string | null }> {
      assertNotHeld();
      const startGen = holdGeneration();
      const { message, agentKind, sessionId } = parseGenerateTitleRequest(rawRequest);
      return { title: await generateMakerSessionTitle(message, agentKind, sessionId, startGen) };
    },
    async regenerateTitle(rawRequest: unknown): Promise<{ title: string | null }> {
      assertNotHeld();
      const startGen = holdGeneration();
      const owner = getCurrentDbClientSnapshot();
      const { sessionId } = parseRegenerateTitleRequest(rawRequest);
      const pendingBeforeDrain = deps.isSessionTurnPendingCompletion(sessionId) === true;
      await deps.drainHistories();
      assertNotHeld();
      if (
        owner !== getCurrentDbClientSnapshot() ||
        isAppSessionBoundaryPending() ||
        holdGeneration() !== startGen
      ) {
        return { title: null };
      }
      let pendingObserved = pendingBeforeDrain;
      const latestTurnIsPendingCompletion = () => {
        if (!pendingObserved) {
          pendingObserved = deps.isSessionTurnPendingCompletion(sessionId) === true;
        }
        return pendingObserved;
      };
      latestTurnIsPendingCompletion();
      const oneShot = makeOneShotCore(startGen);
      const title = await regenerateMakerSessionTitleCore(
        sessionId,
        {
          readSessionAgentKind: readSessionAgentKindFromDb,
          collectMaterial: (sid, recentLimit, inFlight) =>
            regenerateTitleMaterial(sid, recentLimit, inFlight, { preferHookUserText: true }),
          generateTitle: async (sid, agentKind, prompt) => {
            assertNotHeld();
            if (!oneShot || !isRunCurrent(startGen)) return { status: 'failed' };
            return oneShot.generateTitleWithAuxiliaryModelResult({ sessionId: sid, agentKind, prompt });
          },
        },
        latestTurnIsPendingCompletion,
        resolveLocale,
      );
      return { title };
    },
  };
}
