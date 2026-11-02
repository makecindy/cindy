/**
 * maker:experts:* IPC (ROADMAP 3.1b). Read-only bridge over the file-backed expert loader:
 * the renderer lists `~/.cindy-harness/experts` and is told when it changes. The files stay
 * the source of truth; nothing here writes them. The watcher starts on the first list call
 * so an app that never opens an expert surface pays nothing.
 */

import { loadExperts, watchExperts, type ExpertEntry, type ExpertWatcher } from '@cindy/maker-core/experts';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { ExpertDraftConfirm } from './expertDraftConfirm.js';
import { isValidExpertSlug, type ExpertSessionStore } from './expertSessions.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface ExpertsHandlerDeps {
  /** Directory holding one sub-directory per expert (production: ~/.cindy-harness/experts). */
  rootDir: string;
  /** Production: assertTrustedAppRendererEvent. */
  assertTrusted(event: unknown): void;
  /** Production: send to every BrowserWindow. */
  broadcast(channel: string, payload: unknown): void;
  /** Directory watcher; production default is the real `watchExperts`. Injected so tests need no native fs.watch. */
  watch?: typeof watchExperts;
  /** ROADMAP 3.2a: pending pick + session bindings. Omit to register the list only. */
  sessions?: ExpertSessionStore;
  /** ROADMAP 3.8: owner approval of expert drafts. Omit to register without it. */
  drafts?: ExpertDraftConfirm;
}

export interface ExpertsHandlerHandle {
  dispose(): void;
}

export function registerExpertsHandlers(
  registry: IpcHandlerRegistry,
  deps: ExpertsHandlerDeps,
): ExpertsHandlerHandle {
  let watcher: ExpertWatcher | undefined;
  registry.handle(MAKER_INVOKE.EXPERTS_LIST, (event) => {
    deps.assertTrusted(event);
    watcher ??= (deps.watch ?? watchExperts)(deps.rootDir, (entries) => deps.broadcast(MAKER_PUSH.EXPERTS_CHANGED, entries));
    return loadExperts(deps.rootDir);
  });
  const sessions = deps.sessions;
  const offSessionEvents = sessions?.onChange((event) => deps.broadcast(MAKER_PUSH.EXPERTS_SESSION_EVENT, event));
  if (sessions) {
    registry.handle(MAKER_INVOKE.EXPERTS_GET_PENDING, (event) => {
      deps.assertTrusted(event);
      return sessions.getPending();
    });
    registry.handle(MAKER_INVOKE.EXPERTS_SET_PENDING, (event, slug: unknown) => {
      deps.assertTrusted(event);
      if (slug !== null && !isValidExpertSlug(slug)) throw new Error('invalid expert slug');
      return sessions.setPending(slug);
    });
    registry.handle(MAKER_INVOKE.EXPERTS_SESSION_BINDING, (event, sessionId: unknown) => {
      deps.assertTrusted(event);
      if (typeof sessionId !== 'string' || !sessionId) return null;
      return sessions.describeBinding(sessionId);
    });
  }
  const drafts = deps.drafts;
  const offDraftEvents = drafts?.onChange((event) => deps.broadcast(MAKER_PUSH.EXPERTS_DRAFT_EVENT, event));
  if (drafts) {
    registry.handle(MAKER_INVOKE.EXPERTS_DRAFT_LIST, (event, sessionId: unknown) => {
      deps.assertTrusted(event);
      return drafts.list(typeof sessionId === 'string' && sessionId ? sessionId : undefined);
    });
    registry.handle(MAKER_INVOKE.EXPERTS_DRAFT_DECIDE, (event, requestId: unknown, decision: unknown) => {
      deps.assertTrusted(event);
      return drafts.decide(requestId, decision);
    });
  }
  return {
    dispose() {
      offDraftEvents?.();
      offSessionEvents?.();
      watcher?.close();
      watcher = undefined;
    },
  };
}
