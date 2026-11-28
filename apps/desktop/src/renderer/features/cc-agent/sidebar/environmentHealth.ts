import { activeScheduleFailures } from '@cindy/maker-shared/schedule-model';
import type { ScheduleSidebarIndexRun } from '@/features/scheduler/lib/scheduleSidebarIndexRuns';
import {
  AUXILIARY_MODEL_SETTINGS_PATH,
  auxiliaryModelHealthFingerprint,
  type AuxiliaryModelHealth,
} from '../../../../shared/auxiliaryModelHealth';

export type EnvironmentHealthAlertKind =
  | 'provider-auth'
  | 'github-auth'
  | 'gitlab-auth'
  | 'auxiliary-model'
  | 'automation-stalled';

export type EnvironmentHealthSeverity = 'error' | 'warning';

export type EnvironmentHealthAction =
  | { type: 'open-github-connect' }
  | { type: 'navigate'; path: string };

export interface EnvironmentHealthAlert {
  id: string;
  kind: EnvironmentHealthAlertKind;
  severity: EnvironmentHealthSeverity;
  fingerprint: string;
  titleKey: string;
  titleParams?: Record<string, string | number>;
  descriptionKey: string;
  descriptionParams?: Record<string, string | number>;
  actionLabelKey: string;
  action: EnvironmentHealthAction;
}

export interface PrAuthAlertSummary {
  github?: {
    reason: 'gh-missing' | 'gh-not-logged-in';
    affectedPrCount: number;
  };
  gitlab?: {
    reason: 'glab-missing' | 'glab-not-logged-in';
    affectedPrCount: number;
    host?: string;
  };
}

export interface ProviderAuthHealthInput {
  id: string;
  name: string;
  connected?: boolean;
  removed?: boolean;
  suspended?: boolean;
  openAiAccount?: { reconnectRequired?: boolean };
  subscriptionAccount?: { reconnectRequired?: boolean };
  modelDiscoveryFailure?: { kind: string };
}

export interface AuxiliaryHealthInput {
  status: string;
  switchedToBackup?: boolean;
  model: string;
  providerId?: string;
  auxiliaryRef?: string;
}

export interface EnvironmentHealthInputs {
  providers?: readonly ProviderAuthHealthInput[];
  prAuth?: PrAuthAlertSummary;
  auxiliaryHealth?: AuxiliaryModelHealth | null;
  auxiliaryRoutes?: readonly AuxiliaryHealthInput[];
  scheduleRuns?: readonly ScheduleSidebarIndexRun[];
  scheduleFocusPath?: (scheduleId: string) => string;
}

export const PROVIDERS_SETTINGS_PATH = '/settings?tab=providers';
export const GITHUB_PLUGIN_SETTINGS_PATH = '/plugins?ghost=cindy-github';
export const GITLAB_PLUGIN_SETTINGS_PATH = '/plugins?ghost=cindy-gitlab';
export const AUTOMATIONS_PAGE_PATH = '/cc-agent/scheduled';

const DEFAULT_SCHEDULE_FOCUS_PATH = (scheduleId: string) =>
  `/cc-agent/scheduled?focus=${encodeURIComponent(scheduleId)}`;

function formatNamePreview(names: readonly string[], maxVisible = 2): string {
  if (names.length <= maxVisible) return names.join('、');
  return `${names.slice(0, maxVisible).join('、')} +${names.length - maxVisible}`;
}

/**
 * Pure aggregator for Desktop Inbox environment-level health alerts.
 * Only surfaces persistent, user-actionable blockers; transient network/rate-limit
 * errors are intentionally excluded to preserve zero-noise calm.
 */
export function buildEnvironmentHealthAlerts(
  inputs: EnvironmentHealthInputs,
): EnvironmentHealthAlert[] {
  const alerts: EnvironmentHealthAlert[] = [];

  // 1. Model provider authentication expired / unauthorized (skip transient network/upstream).
  const authBrokenProviders = (inputs.providers ?? [])
    .filter(
      (provider) =>
        !provider.removed &&
        !provider.suspended &&
        (provider.openAiAccount?.reconnectRequired === true ||
          provider.subscriptionAccount?.reconnectRequired === true ||
          (provider.connected === true && provider.modelDiscoveryFailure?.kind === 'unauthorized')),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  if (authBrokenProviders.length === 1) {
    const provider = authBrokenProviders[0];
    alerts.push({
      id: 'provider-auth',
      kind: 'provider-auth',
      severity: 'error',
      fingerprint: `provider-auth:${provider.id}`,
      titleKey: 'ccAgent.sidebar.inbox.health.providerAuthSingleTitle',
      titleParams: { name: provider.name },
      descriptionKey: 'ccAgent.sidebar.inbox.health.providerAuthSingleDesc',
      actionLabelKey: 'ccAgent.sidebar.inbox.health.actions.reconnect',
      action: {
        type: 'navigate',
        path: `${PROVIDERS_SETTINGS_PATH}&connect=${encodeURIComponent(provider.id)}`,
      },
    });
  } else if (authBrokenProviders.length > 1) {
    alerts.push({
      id: 'provider-auth',
      kind: 'provider-auth',
      severity: 'error',
      fingerprint: `provider-auth:${authBrokenProviders.map((p) => p.id).join(',')}`,
      titleKey: 'ccAgent.sidebar.inbox.health.providerAuthMultiTitle',
      titleParams: { count: authBrokenProviders.length },
      descriptionKey: 'ccAgent.sidebar.inbox.health.providerAuthMultiDesc',
      descriptionParams: { names: formatNamePreview(authBrokenProviders.map((p) => p.name)) },
      actionLabelKey: 'ccAgent.sidebar.inbox.health.actions.openProviders',
      action: { type: 'navigate', path: PROVIDERS_SETTINGS_PATH },
    });
  }

  // 2. GitHub connection missing or expired while active PR references exist (plugin-first flow).
  const ghAuth = inputs.prAuth?.github;
  if (ghAuth && ghAuth.affectedPrCount > 0) {
    const isMissing = ghAuth.reason === 'gh-missing';
    alerts.push({
      id: 'github-auth',
      kind: 'github-auth',
      severity: 'warning',
      fingerprint: `github-auth:${ghAuth.reason}:${ghAuth.affectedPrCount}`,
      titleKey: isMissing
        ? 'ccAgent.sidebar.inbox.health.githubMissingTitle'
        : 'ccAgent.sidebar.inbox.health.githubNotLoggedInTitle',
      descriptionKey: 'ccAgent.sidebar.inbox.health.prAffectedDesc',
      descriptionParams: { count: ghAuth.affectedPrCount },
      actionLabelKey: 'ccAgent.sidebar.inbox.health.actions.connectGithub',
      action: { type: 'open-github-connect' },
    });
  }

  // 3. GitLab connection missing or expired while active MR references exist (plugin-first flow).
  const glAuth = inputs.prAuth?.gitlab;
  if (glAuth && glAuth.affectedPrCount > 0) {
    alerts.push({
      id: 'gitlab-auth',
      kind: 'gitlab-auth',
      severity: 'warning',
      fingerprint: `gitlab-auth:${glAuth.reason}:${glAuth.host ?? ''}:${glAuth.affectedPrCount}`,
      titleKey:
        glAuth.reason === 'glab-missing'
          ? 'ccAgent.sidebar.inbox.health.gitlabMissingTitle'
          : 'ccAgent.sidebar.inbox.health.gitlabNotLoggedInTitle',
      descriptionKey: 'ccAgent.sidebar.inbox.health.prAffectedDesc',
      descriptionParams: { count: glAuth.affectedPrCount },
      actionLabelKey: 'ccAgent.sidebar.inbox.health.actions.configureGitlab',
      action: { type: 'navigate', path: GITLAB_PLUGIN_SETTINGS_PATH },
    });
  }

  // 4. Auxiliary model chain unavailable (config/runtime) or degraded without backup failover.
  const degradedAuxMap = new Map<string, AuxiliaryHealthInput>();
  for (const route of inputs.auxiliaryRoutes ?? []) {
    if (route.switchedToBackup) continue;
    if (route.status !== 'isolated' && route.status !== 'warning') continue;
    const key = route.auxiliaryRef ?? `${route.providerId ?? ''}:${route.model}`;
    if (!degradedAuxMap.has(key)) degradedAuxMap.set(key, route);
  }
  const degradedAux = [...degradedAuxMap.values()];
  const auxHealthUnavailable = inputs.auxiliaryHealth?.status === 'unavailable' ? inputs.auxiliaryHealth : null;
  if (degradedAux.length > 0 || auxHealthUnavailable) {
    const routeKeys = [...degradedAuxMap.keys()].sort().join(',');
    const chainFp = auxHealthUnavailable
      ? auxiliaryModelHealthFingerprint(auxHealthUnavailable) ?? auxHealthUnavailable.kind
      : '';
    alerts.push({
      id: 'auxiliary-model',
      kind: 'auxiliary-model',
      severity: 'warning',
      fingerprint: `auxiliary-model:${chainFp}|${routeKeys}`,
      titleKey: 'ccAgent.sidebar.inbox.health.auxiliaryTitle',
      descriptionKey:
        degradedAux.length === 1
          ? 'ccAgent.sidebar.inbox.health.auxiliarySingleDesc'
          : degradedAux.length > 1
            ? 'ccAgent.sidebar.inbox.health.auxiliaryMultiDesc'
            : 'ccAgent.sidebar.inbox.health.auxiliaryUnavailableDesc',
      descriptionParams:
        degradedAux.length > 0
          ? {
              count: degradedAux.length,
              model: degradedAux[0].model,
            }
          : undefined,
      actionLabelKey: 'ccAgent.sidebar.inbox.health.actions.openSettings',
      action: { type: 'navigate', path: AUXILIARY_MODEL_SETTINGS_PATH },
    });
  }

  // 5. Active automations blocked / failing (exclude transient rate limits and recovered runs).
  const scheduleRuns = inputs.scheduleRuns ?? [];
  if (scheduleRuns.length > 0) {
    const activeFailureIds = activeScheduleFailures(
      scheduleRuns.map((run) => ({ ...run, id: run.runId })),
    );
    const brokenBySchedule = new Map<string, ScheduleSidebarIndexRun>();
    for (const run of scheduleRuns) {
      if (run.scheduleStatus !== 'active') continue;
      if (run.failureRecovered) continue;
      if (!activeFailureIds.has(run.runId)) continue;
      if (run.failureKind === 'rate-limit') continue;
      const existing = brokenBySchedule.get(run.scheduleId);
      const firedAt = run.firedAt ?? 0;
      const existingFiredAt = existing?.firedAt ?? -1;
      if (!existing || firedAt > existingFiredAt) {
        brokenBySchedule.set(run.scheduleId, run);
      }
    }
    const brokenSchedules = [...brokenBySchedule.values()].sort((a, b) =>
      a.scheduleId.localeCompare(b.scheduleId),
    );
    if (brokenSchedules.length === 1) {
      const target = brokenSchedules[0];
      const focusPath = (inputs.scheduleFocusPath ?? DEFAULT_SCHEDULE_FOCUS_PATH)(
        target.scheduleId,
      );
      alerts.push({
        id: 'automation-stalled',
        kind: 'automation-stalled',
        severity: 'warning',
        fingerprint: `automation-stalled:${target.scheduleId}:${target.runId}`,
        titleKey: 'ccAgent.sidebar.inbox.health.automationSingleTitle',
        titleParams: { name: target.scheduleName },
        descriptionKey: target.missingPlugin
          ? 'ccAgent.sidebar.inbox.health.automationMissingPluginDesc'
          : target.preRunBlocked || target.failureKind === 'precheck'
            ? 'ccAgent.sidebar.inbox.health.automationPrecheckDesc'
            : 'ccAgent.sidebar.inbox.health.automationFailedDesc',
        descriptionParams: target.missingPlugin
          ? { plugin: target.missingPlugin.name ?? target.missingPlugin.ghostId }
          : undefined,
        actionLabelKey: 'ccAgent.sidebar.inbox.health.actions.inspectAutomation',
        action: { type: 'navigate', path: focusPath },
      });
    } else if (brokenSchedules.length > 1) {
      alerts.push({
        id: 'automation-stalled',
        kind: 'automation-stalled',
        severity: 'warning',
        fingerprint: `automation-stalled:${brokenSchedules.map((s) => `${s.scheduleId}:${s.runId}`).join(',')}`,
        titleKey: 'ccAgent.sidebar.inbox.health.automationMultiTitle',
        titleParams: { count: brokenSchedules.length },
        descriptionKey: 'ccAgent.sidebar.inbox.health.automationMultiDesc',
        descriptionParams: {
          names: formatNamePreview(brokenSchedules.map((s) => s.scheduleName)),
        },
        actionLabelKey: 'ccAgent.sidebar.inbox.health.actions.viewAutomations',
        action: { type: 'navigate', path: AUTOMATIONS_PAGE_PATH },
      });
    }
  }

  return alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return 0;
  });
}

export function filterDismissedEnvironmentHealthAlerts(
  alerts: readonly EnvironmentHealthAlert[],
  dismissedFingerprints: ReadonlySet<string>,
): EnvironmentHealthAlert[] {
  if (dismissedFingerprints.size === 0) return [...alerts];
  return alerts.filter((alert) => !dismissedFingerprints.has(alert.fingerprint));
}
