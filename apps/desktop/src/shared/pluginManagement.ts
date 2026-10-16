import type { InstalledGhost } from './ghost';
import type { GhostInstallConsentRequest } from './ghostInstallConsent';
import type { PluginMarketSnapshot } from './pluginMarket';

export interface PluginManagementProject {
  /** Host-owned identity, never a controller filesystem path. */
  id: string;
  name: string;
  /** Read-only target path for the existing scope picker; never a mutation credential. */
  path?: string;
}
export interface PluginManagementProjectState {
  projectId: string;
  revision: string;
  /** Physical plugin instance keys disabled in this project. Global enable remains authoritative. */
  disabled: string[];
}
/** Additive plugins resource capability. Contains declarations, never saved credentials. */
export interface PluginManagementSnapshot {
  version: 1;
  ghosts: InstalledGhost[];
  market: PluginMarketSnapshot;
  /** Absent on older Hosts. Empty means project management is supported with no recent projects. */
  projects?: PluginManagementProject[];
  /** The Host can resolve a directory chosen through the existing remote folder browser. */
  projectBrowse?: true;
  hostPreferences?: true;
  settingsPage?: true;
}
export interface PluginManagementReceipt {
  operationId: string;
  phase: 'running' | 'confirmation' | 'succeeded' | 'cancelled' | 'failed';
  consent?: GhostInstallConsentRequest;
  errorCode?: string;
}
