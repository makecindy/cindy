import {
  getOverwritableAutoTitle,
  isUntitledSessionAwaitingAutoTitle,
  persistSessionTitleIfStillDraft,
  setOnUserSessionTitleWritten,
} from '../localDb/ipc/sessions.js';
import { installTaskTitleWriter, type CreatedTaskTitle } from './createdTaskTitles.js';
import { generateMakerSessionTitle } from './title.js';
import {
  createSessionAutoTitleCore,
  type SessionAutoTitleDeps,
  type SessionAutoTitleRequest,
  type SessionAutoTitleResult,
} from './sessionAutoTitleCore.js';

export type { SessionAutoTitleDeps, SessionAutoTitleRequest, SessionAutoTitleResult };

const core = createSessionAutoTitleCore({
  getDefaultDeps: () => ({
    resolveOverwritableTitle: getOverwritableAutoTitle,
    generateTitle: generateMakerSessionTitle,
    persistTitle: persistSessionTitleIfStillDraft,
  }),
  isUntitledSessionAwaitingAutoTitle: (sessionId, synthesizedPlaceholder) =>
    isUntitledSessionAwaitingAutoTitle(sessionId, synthesizedPlaceholder),
});

export function registerSessionAutoTitleHooks(hooks?: {
  isUserMessageScreeningActive?: () => boolean;
}): void {
  installTaskTitleWriter({
    refine: refineCreatedTaskTitle,
    mayRefine: mayRefineTaskTitle,
    persistInitial: persistInitialTaskTitle,
  });
  setOnUserSessionTitleWritten((sessionId, owner) => {
    core.markSessionManuallyRenamed(sessionId, owner);
  });
  if (hooks?.isUserMessageScreeningActive) {
    core.setUserMessageScreeningProbe(hooks.isUserMessageScreeningActive);
  }
}

export function __resetSessionAutoTitleStateForTest(): void {
  core.resetStateForTest();
}

export function isSessionAutoTitleEligible(sessionId: string): Promise<boolean> {
  return core.isSessionAutoTitleEligible(sessionId);
}

export function refineCreatedTaskTitle(
  sessionId: string,
  text: string,
  creation?: CreatedTaskTitle,
): Promise<string | null> {
  return core.refineCreatedTaskTitle(sessionId, text, creation);
}

export function mayRefineTaskTitle(id: string): boolean {
  return core.mayRefineTaskTitle(id);
}

export function persistInitialTaskTitle(
  id: string,
  title: string,
  initialTitle: string,
): Promise<boolean> {
  return core.persistInitialTaskTitle(id, title, initialTitle);
}

export function runSessionAutoTitle(
  request: SessionAutoTitleRequest,
  deps?: SessionAutoTitleDeps,
): Promise<SessionAutoTitleResult> {
  return core.runSessionAutoTitle(request, deps);
}

export function scheduleSessionAutoTitle(
  request: SessionAutoTitleRequest,
  deps?: SessionAutoTitleDeps,
): void {
  core.scheduleSessionAutoTitle(request, deps);
}
