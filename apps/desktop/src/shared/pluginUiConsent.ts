import { getPluginToolUi } from '@cindy/plugin-protocol';
import { ghostInstallApprovalToken, type InstalledGhost } from './ghost';
import { installedGhostStoragePart } from './pluginIdentity';

/** Only the facts the composer needs; the existing begin operation still verifies consent. */
export interface PluginUiConsentSnapshot {
  version: 1;
  uiCapabilityApproval?: true;
  item?: { instanceKey: string; name: string; approvalToken: string };
}

export function projectPluginUiConsent(
  ghosts: InstalledGhost[],
  supported: boolean,
  suppressed: (ghost: InstalledGhost) => boolean = ghost => !!ghost.uiPromptSuppressed,
): PluginUiConsentSnapshot {
  const item = ghosts.find(ghost => ghost.enabled && ghost.approval.state === 'approved'
    && getPluginToolUi(ghost.manifest) && ghost.uiCapabilityApproved !== true && !suppressed(ghost));
  return {
    version: 1,
    ...(supported ? { uiCapabilityApproval: true as const } : {}),
    ...(item ? { item: { instanceKey: installedGhostStoragePart(item), name: item.manifest.name,
      approvalToken: ghostInstallApprovalToken(item.approval) } } : {}),
  };
}
