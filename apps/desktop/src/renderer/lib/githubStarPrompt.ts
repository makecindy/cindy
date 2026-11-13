import i18n from '@/i18n';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerIdCurrent } from '@/contexts/dataOwnerGeneration';
import { getToastSnapshot, subscribeToastStore, toast, type ToastActionPoint } from './toast';
import { getFileTransferToasts, subscribeFileTransferToasts } from './fileTransferToasts';

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'focusin', 'focusout', 'input'] as const;
const MIN_USAGE_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const QUIET_MS = 60_000;
const OPPORTUNITY_MS = 5 * 60_000;
const REPOSITORY_URL = 'https://github.com/makecindy/cindy';

export interface PromptEnvironment {
  /** No running/queued work, unresolved requests, errors or foreground overlays. */
  isQuiet(): boolean;
  /** The just-completed task or the empty new-task page; never an unrelated task. */
  isEligiblePage(completedSessionId: string): boolean;
  /** Unsent content or an embedded editor prevents admission; composer focus alone does not. */
  isEditing(): boolean;
}

/** A recent successful user turn offers one opportunity, never an idle-time retry loop. */
export function createGithubStarPrompt(deps: PromptEnvironment & {
  storage: Storage;
  ownerId: string;
  isCurrent(): boolean;
  check(): Promise<boolean | null>;
  show(dismiss: () => void): () => void;
}) {
  const prefix = `cindy:github-star:${encodeURIComponent(deps.ownerId)}:`;
  const firstUsedKey = `${prefix}first-used-at`;
  const dismissedKey = `${prefix}dismissed`;
  const shownKey = `${prefix}shown`;
  const accepted = new Map<string, string>();
  let attempted = false;
  let disposed = false;
  let candidate: { sessionId: string; armed: boolean; expiresAt: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let close: (() => void) | undefined;
  const current = () => !disposed && deps.isCurrent();
  const suppressed = () => deps.storage.getItem(dismissedKey) !== null || deps.storage.getItem(shownKey) !== null;
  const foreground = () => !document.hidden && document.hasFocus();
  const cancel = () => {
    candidate = undefined;
    clearTimeout(timer);
    clearTimeout(expiry);
    observer?.disconnect();
    for (const event of ACTIVITY) window.removeEventListener(event, onActivity, true);
    window.removeEventListener('blur', onBlur, true);
    document.removeEventListener('visibilitychange', cancel);
  };
  const onActivity = (event: Event) => {
    // Allow navigation/autofocus before arming, but never restart after actual input.
    if (candidate?.armed || ['keydown', 'wheel', 'input'].includes(event.type)) cancel();
    else queueMicrotask(() => environmentChanged());
  };
  const onBlur = (event: Event) => { if (event.target === event.currentTarget) cancel(); };
  const dismiss = () => {
    if (!current()) return;
    try { deps.storage.setItem(dismissedKey, 'true'); } catch { /* Already reserved as shown. */ }
  };
  const safe = () => current() && foreground() && !suppressed() && deps.isQuiet()
    && (!candidate || Date.now() < candidate.expiresAt);
  const environmentChanged = (navigated = false) => {
    const opportunity = candidate;
    if (!opportunity) return;
    try {
      if (!safe() || Date.now() >= opportunity.expiresAt) return cancel();
      if (opportunity.armed && navigated) return cancel();
      if (!deps.isEligiblePage(opportunity.sessionId)) {
        if (opportunity.armed || navigated) cancel();
        return;
      }
      if (deps.isEditing()) {
        if (opportunity.armed) cancel();
        return;
      }
      if (opportunity.armed) return;
      opportunity.armed = true;
      timer = setTimeout(async () => {
        try {
          if (candidate !== opportunity || !safe() || !deps.isEligiblePage(opportunity.sessionId) || deps.isEditing()) return cancel();
          // Check the current GitHub login and Star immediately before display, once per controller lifetime.
          attempted = true;
          accepted.clear();
          const starred = await deps.check();
          if (candidate !== opportunity || !safe() || !deps.isEligiblePage(opportunity.sessionId) || deps.isEditing()
            || Date.now() >= opportunity.expiresAt) return;
          if (starred === true) { dismiss(); return; }
          if (starred !== false) return;
          // Persist before painting. If persistence fails, suppress the optional notification.
          // Same-tick admission below never waits in the normal toast queue.
          deps.storage.setItem(shownKey, 'true');
          cancel();
          close = deps.show(dismiss);
        } catch { /* Unknown eligibility or persistence means no prompt. */ }
        finally { if (candidate === opportunity) cancel(); }
      }, QUIET_MS);
    } catch { cancel(); }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== dismissedKey && event.key !== shownKey && event.key !== null) return;
    try { if (!suppressed()) return; } catch { /* Unreadable suppression also closes. */ }
    cancel(); close?.();
  };
  window.addEventListener('storage', onStorage);

  return {
    record(sessionId: string, clientId: string) {
      cancel();
      if (!current() || attempted) return;
      try {
        if (suppressed()) return;
        if (deps.storage.getItem(firstUsedKey) === null) deps.storage.setItem(firstUsedKey, String(Date.now()));
        accepted.set(sessionId, clientId);
      } catch { /* No persistence, no invitation. */ }
    },
    complete(sessionId: string, successfulClientId: string | null) {
      // A completion that is not the recorded input (an earlier turn, or null while newer work is
      // queued) must not consume the newer turn's receipt.
      const expected = accepted.get(sessionId);
      if (!expected || expected !== successfulClientId) return;
      accepted.delete(sessionId);
      if (attempted || !current()) return;
      try {
        const raw = deps.storage.getItem(firstUsedKey);
        const firstUsedAt = Number(raw);
        if (!raw?.trim() || !Number.isSafeInteger(firstUsedAt) || firstUsedAt <= 0
          || Date.now() - firstUsedAt < MIN_USAGE_AGE_MS || suppressed()) return;
      } catch { return; }
      cancel();
      candidate = { sessionId, armed: false, expiresAt: Date.now() + OPPORTUNITY_MS };
      expiry = setTimeout(cancel, OPPORTUNITY_MS);
      for (const event of ACTIVITY) window.addEventListener(event, onActivity, { capture: true, passive: true });
      window.addEventListener('blur', onBlur, true);
      document.addEventListener('visibilitychange', cancel);
      observer = new MutationObserver(() => environmentChanged());
      observer.observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['role', 'aria-modal', 'aria-hidden', 'data-state', 'hidden', 'class', 'style'] });
      environmentChanged();
    },
    environmentChanged,
    dispose() {
      disposed = true;
      cancel(); accepted.clear();
      window.removeEventListener('storage', onStorage);
      close?.();
    },
  };
}

let active: ReturnType<typeof createGithubStarPrompt> | undefined;

/** Only renderer-originated, accepted sends call this; push/history/automation do not. */
export function recordGithubStarPromptSend(sessionId: string, clientId: string, owner = getDataOwnerGeneration()): void {
  if (isDataOwnerGenerationCurrent(owner)) active?.record(sessionId, clientId);
}

/** Called only at the live terminal boundary, with the matched user message on clean success. */
export function recordGithubStarPromptCompletion(sessionId: string, clientId: string | null, owner = getDataOwnerGeneration()): void {
  if (isDataOwnerGenerationCurrent(owner)) active?.complete(sessionId, clientId);
}

export function hasGithubStarBlockingUi(): boolean {
  if (getToastSnapshot().length || getFileTransferToasts().length) return true;
  return Array.from(document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="alert"], [role="menu"], [role="listbox"], [data-state="open"][data-radix-popper-content-wrapper]',
  )).some(element => element.getClientRects().length > 0
    && element.getAttribute('aria-hidden') !== 'true' && element.getAttribute('data-state') !== 'closed');
}

export function installGithubStarPrompt(environment: PromptEnvironment & {
  subscribe(listener: (navigated?: boolean) => void): () => void;
}): () => void {
  const owner = getDataOwnerGeneration();
  if (!owner.dataOwnerId) return () => {};
  let storage: Storage;
  try { storage = window.localStorage; } catch { return () => {}; }
  let stopped = false;
  // Same-owner repairs advance the generation without remounting; storage is keyed by owner id only.
  const isCurrent = () => !stopped && isDataOwnerIdCurrent(owner);
  const controller = createGithubStarPrompt({
    ...environment,
    isQuiet: () => environment.isQuiet() && !hasGithubStarBlockingUi(),
    storage, ownerId: owner.dataOwnerId, isCurrent,
    check: () => window.electronAPI.gitContext.checkCindyStar(),
    show: (dismiss) => showGithubStarPrompt(dismiss, isCurrent),
  });
  const unsubscribe = environment.subscribe(controller.environmentChanged);
  const unsubscribeToasts = subscribeToastStore(() => controller.environmentChanged());
  const unsubscribeTransfers = subscribeFileTransferToasts(() => controller.environmentChanged());
  active = controller;
  return () => {
    stopped = true;
    unsubscribe(); unsubscribeToasts(); unsubscribeTransfers();
    controller.dispose();
    if (active === controller) active = undefined;
  };
}

/** Shared notification interaction, also exercised by the isolated UI preview. */
export function showGithubStarPrompt(
  dismiss: () => void,
  isCurrent: () => boolean,
  actions: { star(): Promise<boolean | null>; open(): Promise<{ success: boolean }> } = {
    star: () => window.electronAPI.gitContext.starCindy(),
    open: () => window.electronAPI.openExternal(REPOSITORY_URL),
  },
): () => void {
  let closed = false;
  let busy = false;
  const openBrowser = async () => {
    if (!isCurrent() || closed) return;
    try {
      const result = await actions.open();
      if (!isCurrent() || closed) return;
      if (result.success) { dismiss(); toast.dismiss(id); return; }
    } catch { /* Keep a retryable link visible if the browser could not open. */ }
    if (isCurrent() && !closed) toast.update(id, i18n.t('githubStar.openFailed'));
  };
  const star = async (point?: ToastActionPoint) => {
    if (busy || closed || !isCurrent()) return;
    busy = true;
    const celebrationOrigin = point ? { ...point } : undefined;
    toast.update(id, i18n.t('githubStar.description'), {
      action: { label: i18n.t('githubStar.starring'), emphasis: 'cta', onClick: () => {}, disabled: true, keepOpen: true },
    });
    let starred = false;
    try { starred = await actions.star() === true; } catch { /* Browser fallback. */ }
    if (closed || !isCurrent()) return;
    if (starred) {
      dismiss();
      toast.update(id, i18n.t('githubStar.thanksDescription'), {
        title: i18n.t('githubStar.thanks'), variant: 'success', icon: undefined, celebrate: true, celebrationOrigin,
        action: undefined, dismissLabel: undefined, duration: 5_000, pauseOnHover: false,
      });
      return;
    }
    toast.update(id, i18n.t('githubStar.browserFallback'), {
      action: { label: i18n.t('githubStar.openGithub'), emphasis: 'cta', onClick: () => void openBrowser(), keepOpen: true },
    });
    await openBrowser();
  };
  const id = toast.info(i18n.t('githubStar.description'), {
    title: i18n.t('githubStar.title'), icon: 'star', duration: 0, placement: 'top-right',
    dismissLabel: i18n.t('githubStar.dismiss'),
    action: { label: i18n.t('githubStar.action'), emphasis: 'cta', onClick: (point) => void star(point), keepOpen: true },
    onClose: () => { closed = true; if (isCurrent()) dismiss(); },
  });
  return () => { closed = true; toast.dismiss(id); };
}
