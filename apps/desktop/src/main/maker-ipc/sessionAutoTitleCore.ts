import type { AgentKind } from '@cindy/maker-core';
import { normalizeAutoTitle } from '@cindy/maker-shared/session-title';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import type { CreatedTaskTitle } from './createdTaskTitles.js';

const log = createLogger('maker-ipc/session-auto-title');

export interface OverwritableAutoTitleTarget {
  title: string;
  agentKind: 'claude-code' | 'codex' | 'pi' | null;
  isDefaultDraftTitle: boolean;
}

export interface SessionAutoTitleRequest {
  sessionId: string;
  text: string;
  placeholderText?: string;
  agentKind: AgentKind | null;
  isUserText?: boolean;
}

export interface SessionAutoTitleResult {
  applied: boolean;
  done: boolean;
}

export interface SessionAutoTitleDeps {
  resolveOverwritableTitle: (
    sessionId: string,
    synthesizedPlaceholder?: string,
  ) => Promise<OverwritableAutoTitleTarget | null>;
  generateTitle: (message: string, agentKind: AgentKind | null, sessionId?: string) => Promise<string | null>;
  persistTitle: (sessionId: string, title: string, expectedTitle?: string) => Promise<boolean>;
}

export type TitleOwner = NonNullable<ReturnType<typeof getCurrentDbClientSnapshot>>;

export interface SessionAutoTitleCorePorts {
  getDefaultDeps: () => SessionAutoTitleDeps;
  isUntitledSessionAwaitingAutoTitle: (
    sessionId: string,
    synthesizedPlaceholder?: string | null,
  ) => Promise<boolean>;
  canWrite?: () => boolean;
}

function newTitleWork() {
  return {
    queues: new Map<string, Promise<unknown>>(),
    synthesizedPlaceholders: new Map<string, string>(),
    awaitingTopicText: new Map<string, CreatedTaskTitle>(),
  };
}

export function createSessionAutoTitleCore(ports: SessionAutoTitleCorePorts) {
  let workByOwner = new WeakMap<TitleOwner, ReturnType<typeof newTitleWork>>();
  const manualRenamesByAccount = new Map<string, Set<string>>();
  let isUserMessageScreeningActive: (() => boolean) | null = null;

  function titleWork(owner: TitleOwner) {
    let work = workByOwner.get(owner);
    if (!work) {
      work = newTitleWork();
      workByOwner.set(owner, work);
    }
    return work;
  }

  function isTitleOwnerCurrent(owner: TitleOwner): boolean {
    return (
      getCurrentDbClientSnapshot() === owner &&
      !isAppSessionBoundaryPending() &&
      ports.canWrite?.() !== false
    );
  }

  function enqueuePerSession<T>(owner: TitleOwner, sessionId: string, task: () => Promise<T>): Promise<T> {
    const { queues } = titleWork(owner);
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(sessionId, settled);
    void settled.then(() => {
      if (queues.get(sessionId) === settled) queues.delete(sessionId);
    });
    return next;
  }

  function wasManuallyRenamed(owner: TitleOwner, id: string): boolean {
    return manualRenamesByAccount.get(owner.userId)?.has(id) ?? false;
  }

  function markSessionManuallyRenamed(sessionId: string, owner?: TitleOwner | null): void {
    const targetOwner = owner === undefined ? getCurrentDbClientSnapshot() : owner;
    if (!targetOwner) return;
    let renamed = manualRenamesByAccount.get(targetOwner.userId);
    if (!renamed) {
      renamed = new Set();
      manualRenamesByAccount.set(targetOwner.userId, renamed);
    }
    renamed.add(sessionId);
    const { awaitingTopicText, synthesizedPlaceholders } = titleWork(targetOwner);
    awaitingTopicText.delete(sessionId);
    synthesizedPlaceholders.delete(sessionId);
  }

  function setUserMessageScreeningProbe(probe: (() => boolean) | null): void {
    isUserMessageScreeningActive = probe;
  }

  function resetStateForTest(): void {
    workByOwner = new WeakMap();
    manualRenamesByAccount.clear();
  }

  async function isSessionAutoTitleEligible(sessionId: string): Promise<boolean> {
    const owner = getCurrentDbClientSnapshot();
    if (!owner) return ports.isUntitledSessionAwaitingAutoTitle(sessionId);
    if (!isTitleOwnerCurrent(owner) || wasManuallyRenamed(owner, sessionId)) return false;
    const { synthesizedPlaceholders } = titleWork(owner);
    const eligible = await ports.isUntitledSessionAwaitingAutoTitle(
      sessionId,
      synthesizedPlaceholders.get(sessionId),
    );
    if (!eligible) synthesizedPlaceholders.delete(sessionId);
    return eligible && isTitleOwnerCurrent(owner);
  }

  async function runUnsynchronized(
    request: Omit<SessionAutoTitleRequest, 'agentKind'>,
    deps: SessionAutoTitleDeps,
    owner: TitleOwner,
  ): Promise<SessionAutoTitleResult> {
    const seedText = request.text.trim();
    if (!seedText) return { applied: false, done: false };

    const stopped = () => !isTitleOwnerCurrent(owner) || wasManuallyRenamed(owner, request.sessionId);
    if (stopped()) return { applied: false, done: true };

    const { synthesizedPlaceholders } = titleWork(owner);
    const remembered = synthesizedPlaceholders.get(request.sessionId);

    let target: OverwritableAutoTitleTarget | null;
    try {
      target = await deps.resolveOverwritableTitle(request.sessionId, remembered);
    } catch (err) {
      log.warn('auto-title eligibility check failed', {
        sessionId: request.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { applied: false, done: false };
    }
    if (target === null || stopped()) {
      synthesizedPlaceholders.delete(request.sessionId);
      return { applied: false, done: true };
    }

    const placeholder = normalizeAutoTitle(request.placeholderText?.trim() || seedText);
    if (!placeholder) return { applied: false, done: false };

    if (request.isUserText === false && !target.isDefaultDraftTitle) {
      return { applied: false, done: false };
    }

    let placeholderPersisted = false;
    try {
      placeholderPersisted = await deps.persistTitle(request.sessionId, placeholder, target.title);
    } catch (err) {
      log.warn('auto-title placeholder write failed (continuing)', {
        sessionId: request.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    if (request.isUserText === false) {
      synthesizedPlaceholders.set(request.sessionId, placeholder);
      return { applied: placeholderPersisted, done: false };
    }

    if (placeholderPersisted) synthesizedPlaceholders.delete(request.sessionId);

    let expectedForSmart = placeholderPersisted ? placeholder : target.title;
    let placeholderLive = placeholderPersisted;
    if (!placeholderPersisted) {
      try {
        const latest = await deps.resolveOverwritableTitle(request.sessionId, placeholder);
        if (latest === null) {
          return { applied: false, done: true };
        }
        expectedForSmart = latest.title;
        placeholderLive = latest.title === placeholder;
      } catch (err) {
        log.warn('auto-title re-resolve after ambiguous placeholder write failed', {
          sessionId: request.sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (stopped() || isUserMessageScreeningActive?.()) {
      return { applied: placeholderLive, done: placeholderLive };
    }

    let generated: string | undefined;
    try {
      generated = (await deps.generateTitle(seedText, target.agentKind, request.sessionId))?.trim();
    } catch (err) {
      log.warn('auto-title generation failed', {
        sessionId: request.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (!generated) return { applied: placeholderLive, done: placeholderLive };
    if (stopped()) {
      return { applied: placeholderLive, done: true };
    }

    let smartPersisted = false;
    try {
      smartPersisted = await deps.persistTitle(request.sessionId, generated, expectedForSmart);
    } catch (err) {
      log.warn('auto-title smart write failed', {
        sessionId: request.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    const applied = smartPersisted || placeholderLive;
    return { applied, done: applied };
  }

  async function refineCreatedTaskTitle(
    sessionId: string,
    text: string,
    creation?: CreatedTaskTitle,
  ): Promise<string | null> {
    const owner = getCurrentDbClientSnapshot();
    if (!owner || !isTitleOwnerCurrent(owner) || wasManuallyRenamed(owner, sessionId)) return null;
    const current = () => isTitleOwnerCurrent(owner);
    const { awaitingTopicText } = titleWork(owner);
    const naming = creation ?? awaitingTopicText.get(sessionId);
    if (!naming) return null;
    if (!text.trim()) {
      if (creation) awaitingTopicText.set(sessionId, creation);
      return null;
    }
    awaitingTopicText.delete(sessionId);
    const { initialTitle, format = normalizeAutoTitle, compose } = naming;
    let applied: string | null = null;
    const baseDeps = ports.getDefaultDeps();
    try {
      await enqueuePerSession(owner, sessionId, () =>
        runUnsynchronized(
          { sessionId, text, placeholderText: format(text) },
          {
            resolveOverwritableTitle: async (id, attempted) => {
              if (!current()) return null;
              const expected = attempted ?? initialTitle;
              const row = await baseDeps.resolveOverwritableTitle(id, expected);
              return row?.title === expected && current() ? row : null;
            },
            generateTitle: async (seed, kind, id) => {
              if (!current()) return null;
              const topic = await baseDeps.generateTitle(seed, kind, id);
              if (!topic || !current()) return null;
              return (await compose?.(topic)) || format(topic);
            },
            persistTitle: async (id, title, expected) => {
              if (!current() || wasManuallyRenamed(owner, id)) return false;
              const saved = await baseDeps.persistTitle(id, title, expected);
              if (saved && current()) applied = normalizeAutoTitle(title);
              return saved;
            },
          },
          owner,
        ),
      );
    } catch (error) {
      log.warn('created task title unavailable', {
        sessionId,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
    return current() && !wasManuallyRenamed(owner, sessionId) ? applied : null;
  }

  function mayRefineTaskTitle(id: string): boolean {
    const owner = getCurrentDbClientSnapshot();
    return !!owner && isTitleOwnerCurrent(owner) && !wasManuallyRenamed(owner, id);
  }

  async function persistInitialTaskTitle(id: string, title: string, initialTitle: string): Promise<boolean> {
    return mayRefineTaskTitle(id) && ports.getDefaultDeps().persistTitle(id, title, initialTitle);
  }

  function runSessionAutoTitle(
    request: SessionAutoTitleRequest,
    deps?: SessionAutoTitleDeps,
  ): Promise<SessionAutoTitleResult> {
    const owner = getCurrentDbClientSnapshot();
    if (!owner) return Promise.resolve({ applied: false, done: false });
    const resolvedDeps = deps ?? ports.getDefaultDeps();
    return enqueuePerSession(owner, request.sessionId, async () => {
      const result = await runUnsynchronized(request, resolvedDeps, owner);
      return isTitleOwnerCurrent(owner) ? result : { applied: false, done: false };
    });
  }

  function scheduleSessionAutoTitle(
    request: SessionAutoTitleRequest,
    deps?: SessionAutoTitleDeps,
  ): void {
    void runSessionAutoTitle(request, deps).catch((err) => {
      log.warn('auto-title failed', {
        sessionId: request.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    markSessionManuallyRenamed,
    setUserMessageScreeningProbe,
    resetStateForTest,
    isSessionAutoTitleEligible,
    refineCreatedTaskTitle,
    mayRefineTaskTitle,
    persistInitialTaskTitle,
    runSessionAutoTitle,
    scheduleSessionAutoTitle,
  };
}
