/**
 * Progress and outcome of organization publishes started from the UI (#1541).
 *
 * Lives at app level and is keyed by account, so leaving the plugin page neither drops the
 * subscription nor the result: toasts still report the outcome, and the "My plugins" page lists
 * what is in progress or finished until the user dismisses it. Switching accounts clears it.
 * Only transfers this window started are followed. Progress arrives on the existing
 * `plugin-publisher:progress` push; one status read catches up if the transfer already moved.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { useAuth } from './AuthContext';

const copy = 'settings.ghosts.publish.progress';
const ACTIVE_STAGES = new Set(['hashing', 'preparing', 'uploading', 'committing', 'processing']);
/** Finished results are kept until dismissed; the oldest beyond this count drop off. */
const MAX_ENTRIES = 10;

interface Progress {
  transferId: string;
  stage: string;
  bytesSent?: number;
  totalBytes?: number;
  reviewStatus?: string | null;
  version?: string | null;
  pluginName?: string | null;
  errorCode?: string | null;
  failure?: { code?: string } | null;
}

export interface TeamPublishEntry {
  transferId: string;
  state: 'active' | 'succeeded' | 'failed';
  /** i18n key under settings.ghosts.publish.progress and its arguments. */
  messageKey: string;
  args: Record<string, string | number>;
}

function isProgress(value: unknown): value is Progress {
  return Boolean(value) && typeof value === 'object' &&
    typeof (value as Progress).transferId === 'string' && typeof (value as Progress).stage === 'string';
}

const TeamPublishProgressContext = createContext<{
  entries: TeamPublishEntry[];
  track: (transferId: string, name: string) => void;
  dismiss: (transferId: string) => void;
}>({ entries: [], track: () => {}, dismiss: () => {} });

export const useTeamPublishProgress = () => useContext(TeamPublishProgressContext);

export function TeamPublishProgressProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { dataOwnerId, dataOwnerGeneration, user, mode } = useAuth();
  const owner = JSON.stringify([dataOwnerId, dataOwnerGeneration, user?.id, mode]);
  // Only organization identities can publish to team sharing.
  const enabled = mode === 'cloud' && user?.membershipKind === 'org';
  const current = useRef(owner);
  current.current = owner;
  const tracked = useRef(new Map<string, { owner: string; name: string; toastId: string | null }>());
  const [snapshot, setSnapshot] = useState<{ owner: string; entries: TeamPublishEntry[] }>({ owner, entries: [] });

  // A different account never sees the previous account's publishes.
  useEffect(() => {
    const map = tracked.current;
    return () => {
      for (const entry of map.values()) if (entry.toastId) toast.dismiss(entry.toastId);
      map.clear();
    };
  }, [owner]);

  const put = useCallback((entryOwner: string, transferId: string, next: TeamPublishEntry | null) => {
    setSnapshot((previous) => {
      const base = previous.owner === entryOwner ? previous.entries : [];
      const others = base.filter((entry) => entry.transferId !== transferId);
      return { owner: entryOwner, entries: next ? [next, ...others].slice(0, MAX_ENTRIES) : others };
    });
  }, []);

  const apply = useCallback((progress: Progress) => {
    const entry = tracked.current.get(progress.transferId);
    if (!entry || entry.owner !== current.current) return;
    const name = progress.pluginName ?? entry.name;
    const version = progress.version ?? '';
    const settle = (state: 'succeeded' | 'failed', messageKey: string) => {
      if (entry.toastId) toast.dismiss(entry.toastId);
      tracked.current.delete(progress.transferId);
      const args = { name, version };
      put(entry.owner, progress.transferId, { transferId: progress.transferId, state, messageKey, args });
      if (state === 'succeeded') toast.success(t(`${copy}.${messageKey}`, args));
      else toast.error(t(`${copy}.${messageKey}`, args));
    };
    if (ACTIVE_STAGES.has(progress.stage)) {
      const percent = progress.stage === 'uploading' && progress.totalBytes
        ? Math.min(100, Math.floor(((progress.bytesSent ?? 0) / progress.totalBytes) * 100)) : null;
      const messageKey = percent === null ? 'publishing' : 'uploading';
      const args: Record<string, string | number> = percent === null ? { name } : { name, percent };
      const message = t(`${copy}.${messageKey}`, args);
      if (entry.toastId) toast.update(entry.toastId, message);
      else entry.toastId = toast.loading(message);
      put(entry.owner, progress.transferId, { transferId: progress.transferId, state: 'active', messageKey, args });
      return;
    }
    if (progress.stage === 'succeeded') {
      settle('succeeded', progress.reviewStatus === 'approved' ? 'published' : 'submitted');
      return;
    }
    if (progress.stage === 'cancelled' || (progress.stage === 'failed' && progress.errorCode === 'CONFIRM_UNAVAILABLE')) {
      // The user cancelled on the confirmation screen: nothing to report.
      if (entry.toastId) toast.dismiss(entry.toastId);
      tracked.current.delete(progress.transferId);
      put(entry.owner, progress.transferId, null);
      return;
    }
    if (progress.stage === 'expired') {
      settle('failed', 'expired');
      return;
    }
    if (progress.stage === 'failed') {
      const code = progress.errorCode ?? progress.failure?.code ?? null;
      settle('failed', code === 'AUDIENCE_UNSUPPORTED' ? 'audienceUnsupported'
        : code === 'NETWORK_UNREACHABLE' ? 'networkUnreachable'
          : code === 'PUBLISH_VERSION_EXISTS' ? 'versionExists'
            : 'failed');
    }
  }, [put, t]);

  useEffect(() => {
    // Windows without the publisher bridge never start team publishes.
    const bridge = window.electronAPI?.pluginPublisher;
    if (!enabled || !bridge) return;
    return bridge.onProgress((raw) => {
      if (isProgress(raw)) apply(raw);
    });
  }, [apply, enabled]);

  const track = useCallback((transferId: string, name: string) => {
    if (tracked.current.has(transferId)) return;
    tracked.current.set(transferId, { owner: current.current, name, toastId: null });
    void window.electronAPI.pluginPublisher.status(transferId).then(
      ({ progress }) => { if (isProgress(progress)) apply(progress); },
      () => undefined,
    );
  }, [apply]);

  const dismiss = useCallback((transferId: string) => {
    put(current.current, transferId, null);
  }, [put]);

  const entries = useMemo(() => enabled && snapshot.owner === owner ? snapshot.entries : [],
    [enabled, snapshot, owner]);
  const value = useMemo(() => ({ entries, track, dismiss }), [entries, track, dismiss]);
  return <TeamPublishProgressContext.Provider value={value}>{children}</TeamPublishProgressContext.Provider>;
}
