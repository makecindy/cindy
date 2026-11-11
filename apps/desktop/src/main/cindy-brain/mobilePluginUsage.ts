import type { PluginUsageSummary, PluginConfigurationSummary } from '@cindy/device-link';
import type { GhostSetupAssessment, InstalledGhost } from '../../shared/ghost.js';

/** Read-only detail projection; setup presence checks are not credential validity checks. */
export function mobilePluginUsage(
  ghost: InstalledGhost,
  assessment?: GhostSetupAssessment,
  runtimeState?: string,
  configuration?: PluginConfigurationSummary,
): PluginUsageSummary {
  const m = ghost.manifest;
  const unmet =
    assessment?.groups.filter((group) => !group.items.some((item) => item.state === 'satisfied')) ??
    [];
  const labels = (state: 'missing' | 'expired') =>
    [
      ...new Set(
        unmet.flatMap((group) =>
          group.items
            .filter((item) => item.state === state)
            .map((item) => item.label.slice(0, 160)),
        ),
      ),
    ].slice(0, 64);
  return {
    taskUsable: Boolean(m.command || m.tools?.length || m.skill?.items.length),
    hasSettings: Boolean(m.settingsHtml),
    approvalRequired: ghost.approval.state !== 'approved',
    builtin: ghost.builtin === true,
    retired: Boolean(ghost.retirement),
    ...(configuration ? { configuration } : {}),
    ...(runtimeState === 'crashed' || runtimeState === 'fused'
      ? { runtimeIssue: runtimeState }
      : {}),
    setup: {
      state: assessment?.state ?? 'unknown',
      missing: labels('missing'),
      expired: labels('expired'),
      groups: unmet.slice(0, 64).map((group) => ({
        missing: group.items
          .filter((item) => item.state === 'missing')
          .map((item) => item.label.slice(0, 160))
          .slice(0, 64),
        expired: group.items
          .filter((item) => item.state === 'expired')
          .map((item) => item.label.slice(0, 160))
          .slice(0, 64),
      })),
    },
  };
}
