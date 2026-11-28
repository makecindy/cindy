import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { SchedulerEvent } from '@cindy/maker-scheduler';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { isDataOwnerPushCurrent, isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { useLocalPrAuthAlerts } from '@/contexts/PrRefsContext';
import { useProviders } from '@/hooks/useProviders';
import {
  loadScheduleSidebarIndexRuns,
  type ScheduleSidebarIndexRun,
} from '@/features/scheduler/lib/scheduleSidebarIndexRuns';
import { scheduleFocusPath } from '@/features/scheduler/lib/scheduleSessionBinding';
import { GithubAccountCard } from '@/features/cc-agent/GithubAccountCard';
import type { Session } from '@/lib/ccAgent.types';
import {
  AUXILIARY_MODEL_HEALTH_SECTION,
  type AuxiliaryModelHealth,
  type AuxiliaryModelHealthEvent,
} from '../../../../shared/auxiliaryModelHealth';
import {
  GITHUB_PLUGIN_SETTINGS_PATH,
  buildEnvironmentHealthAlerts,
  filterDismissedEnvironmentHealthAlerts,
  type EnvironmentHealthAction,
  type EnvironmentHealthAlert,
} from './environmentHealth';

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();

function auxRouteKey(row: AuxiliaryModelHealthEvent): string {
  return row.auxiliaryRef ?? JSON.stringify([row.providerId, row.model]);
}

export interface UseEnvironmentHealthAlertsResult {
  alerts: EnvironmentHealthAlert[];
  onAction: (action: EnvironmentHealthAction, alert: EnvironmentHealthAlert) => void;
  onDismiss: (fingerprint: string) => void;
  githubSetupDialog: ReactNode;
}

/**
 * Aggregates cross-task environment health signals for the Desktop Inbox:
 * - Model provider authentication expired / unauthorized
 * - Local GitHub / GitLab CLI auth missing or expired (when local PRs exist)
 * - Auxiliary model chain degraded / isolated without backup failover
 * - Active automations stalled or failing (excluding transient rate limits)
 *
 * When `enabled` is false (classic task list mode), performs zero IPC or subscriptions.
 */
export function useEnvironmentHealthAlerts({
  enabled,
  localSessions,
}: {
  enabled: boolean;
  localSessions: readonly Session[];
}): UseEnvironmentHealthAlertsResult {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { dataOwnerId, dataOwnerGeneration } = useAuth();
  const { providers } = useProviders();

  const localSessionIds = useMemo(() => {
    if (!enabled) return EMPTY_SESSION_IDS;
    const set = new Set<string>();
    for (const session of localSessions) {
      if (session.remoteHostId || session.deviceLinkDeviceId) continue;
      set.add(session.id);
    }
    return set;
  }, [enabled, localSessions]);

  const prAuth = useLocalPrAuthAlerts(localSessionIds);
  const [auxiliaryHealth, setAuxiliaryHealth] = useState<AuxiliaryModelHealth | null>(null);
  const [auxiliaryRoutes, setAuxiliaryRoutes] = useState<AuxiliaryModelHealthEvent[]>([]);
  const [scheduleRuns, setScheduleRuns] = useState<ScheduleSidebarIndexRun[]>([]);
  const [dismissedFingerprints, setDismissedFingerprints] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [githubConnectOpen, setGithubConnectOpen] = useState(false);

  // Reset per-session dismissals when account / data owner changes.
  useEffect(() => {
    setDismissedFingerprints(new Set());
  }, [dataOwnerId, dataOwnerGeneration]);

  // Subscribe to global auxiliary-model chain + route health only while Inbox mode is active.
  useEffect(() => {
    if (!enabled) {
      setAuxiliaryHealth(null);
      setAuxiliaryRoutes([]);
      return;
    }
    const api = window.electronAPI?.maker;
    const appPreferenceControl = window.electronAPI?.appPreferenceControl;
    let disposed = false;

    const refreshChainHealth = () => {
      if (!api?.auxiliaryModelHealthGet) return;
      void api
        .auxiliaryModelHealthGet()
        .then((next) => {
          if (!disposed) setAuxiliaryHealth(next);
        })
        .catch(() => {});
    };
    refreshChainHealth();
    const offSettings = appPreferenceControl?.onSettingsChanged?.((event) => {
      if (
        event.section === AUXILIARY_MODEL_HEALTH_SECTION &&
        isDataOwnerPushStampCurrent(event.ownerStamp)
      ) {
        refreshChainHealth();
      }
    });
    const offProviders = api?.onProvidersChanged?.(refreshChainHealth);

    if (!api?.auxiliaryModelRouteHealthGet) {
      return () => {
        disposed = true;
        offSettings?.();
        offProviders?.();
      };
    }
    const current = new Map<string, AuxiliaryModelHealthEvent>();
    const publish = () => {
      if (!disposed) {
        setAuxiliaryRoutes([...current.values()].sort((a, b) => b.lastErrorAt - a.lastErrorAt));
      }
    };
    void api
      .auxiliaryModelRouteHealthGet()
      .then((snapshot) => {
        if (disposed || !Array.isArray(snapshot)) return;
        for (const row of snapshot) {
          if (!isDataOwnerPushStampCurrent(row.ownerStamp)) continue;
          current.set(auxRouteKey(row), row);
        }
        publish();
      })
      .catch(() => {});
    const off = api.onAuxiliaryModelHealthChanged?.((row) => {
      if (disposed || !isDataOwnerPushStampCurrent(row.ownerStamp)) return;
      if (row.conversationOnly) return;
      const key = auxRouteKey(row);
      if (row.removed) current.delete(key);
      else current.set(key, row);
      publish();
    });
    return () => {
      disposed = true;
      off?.();
      offSettings?.();
      offProviders?.();
    };
  }, [enabled, dataOwnerId, dataOwnerGeneration]);

  // Load and reactively refresh active schedule failures only while Inbox mode is active.
  const scheduleRefreshSeq = useRef(0);
  useEffect(() => {
    if (!enabled) {
      setScheduleRuns([]);
      return;
    }
    const scheduleApi = window.electronAPI?.maker?.schedule;
    if (!scheduleApi?.listSidebarIndexRuns) return;
    let disposed = false;
    const refresh = () => {
      const seq = ++scheduleRefreshSeq.current;
      void loadScheduleSidebarIndexRuns()
        .then((runs) => {
          if (!disposed && scheduleRefreshSeq.current === seq) {
            setScheduleRuns(runs);
          }
        })
        .catch(() => {});
    };
    refresh();
    const off = scheduleApi.onEvent?.((raw, ownerStamp) => {
      if (!isDataOwnerPushCurrent(ownerStamp)) return;
      const event = raw as SchedulerEvent;
      if (
        event.type === 'ready' ||
        event.type === 'changed' ||
        event.type === 'completed' ||
        event.type === 'failed' ||
        (event.type === 'skipped' && event.preRunCheckSucceeded === true)
      ) {
        refresh();
      }
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [enabled, dataOwnerId, dataOwnerGeneration]);

  const rawAlerts = useMemo(() => {
    if (!enabled) return [];
    return buildEnvironmentHealthAlerts({
      providers,
      prAuth,
      auxiliaryHealth,
      auxiliaryRoutes,
      scheduleRuns,
      scheduleFocusPath,
    });
  }, [enabled, providers, prAuth, auxiliaryHealth, auxiliaryRoutes, scheduleRuns]);

  const alerts = useMemo(
    () => filterDismissedEnvironmentHealthAlerts(rawAlerts, dismissedFingerprints),
    [rawAlerts, dismissedFingerprints],
  );

  const onDismiss = useCallback((fingerprint: string) => {
    setDismissedFingerprints((previous) => {
      if (previous.has(fingerprint)) return previous;
      const next = new Set(previous);
      next.add(fingerprint);
      return next;
    });
  }, []);

  const onAction = useCallback(
    (action: EnvironmentHealthAction) => {
      if (action.type === 'open-github-connect') {
        setGithubConnectOpen(true);
        return;
      }
      navigate(action.path);
    },
    [navigate],
  );

  // Plugin-first GitHub connection dialog: surfaces Cindy's GitHub App / plugin connection
  // as the primary flow, keeping local gh CLI tucked inside the alternative section.
  const githubSetupDialog = githubConnectOpen ? (
    <Dialog.Root open onOpenChange={setGithubConnectOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-modal-raised flex max-h-[85vh] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto p-4 outline-none"
        >
          <Dialog.Title className="text-16 font-medium text-[var(--confirm-title)]">
            GitHub
          </Dialog.Title>
          <GithubAccountCard
            includeEvents
            pluginSettings
            onConnected={() => setGithubConnectOpen(false)}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="sm"
              onClick={() => {
                setGithubConnectOpen(false);
                navigate(GITHUB_PLUGIN_SETTINGS_PATH);
              }}
            >
              {t('ccAgent.sidebar.inbox.health.actions.openGithubPlugin')}
            </Button>
            <Dialog.Close asChild>
              <Button variant="secondary">
                {t('ccAgent.gitContext.pr.setup.connection.close')}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  ) : null;

  return {
    alerts,
    onAction,
    onDismiss,
    githubSetupDialog,
  };
}
