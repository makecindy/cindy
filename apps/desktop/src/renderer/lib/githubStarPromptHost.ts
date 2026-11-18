import { matchPath } from 'react-router-dom';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { getDraftPresence, subscribeDraftContent } from './composerDraftStore';
import { makerChatStore } from './makerChatStore';
import type { PromptEnvironment } from './githubStarPrompt';
import type { router as appRouter } from '@/router';

type PromptRouter = Pick<typeof appRouter, 'state' | 'subscribe'>;

/** Keep route/draft eligibility shared by the desktop host and its development preview. */
export function createGithubStarPromptEnvironment(router: PromptRouter): PromptEnvironment & {
  subscribe(listener: (navigated?: boolean) => void): () => void;
} {
  const draftKey = () => {
    const path = router.state.location.pathname;
    if (path === '/cc-agent/new') return NEW_MAKER_DRAFT_KEY;
    return matchPath('/cc-agent/:sessionId', path)?.params.sessionId ?? null;
  };
  return {
    isQuiet: () => !makerChatStore.hasGithubStarBlockingWork(),
    isEligiblePage: sessionId => router.state.navigation.state === 'idle'
      && (draftKey() === sessionId || draftKey() === NEW_MAKER_DRAFT_KEY),
    isEditing: () => {
      const key = draftKey();
      return key === null || getDraftPresence(key)
        || !!document.activeElement?.matches('iframe, webview');
    },
    subscribe: listener => {
      const stopTasks = makerChatStore.subscribeAll(() => listener());
      let key = draftKey();
      let stopDraft = key ? subscribeDraftContent(key, () => listener()) : undefined;
      let locationKey = router.state.location.key;
      const stopRoute = router.subscribe(state => {
        const navigated = state.location.key !== locationKey;
        locationKey = state.location.key;
        const nextKey = draftKey();
        if (nextKey !== key) {
          stopDraft?.();
          key = nextKey;
          stopDraft = key ? subscribeDraftContent(key, () => listener()) : undefined;
        }
        listener(navigated);
      });
      return () => { stopTasks(); stopDraft?.(); stopRoute(); };
    },
  };
}
