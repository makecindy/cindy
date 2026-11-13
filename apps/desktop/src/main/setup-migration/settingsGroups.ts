/**
 * Settings that new-computer setup copies (docs/product-rules/new-device-setup-migration.md).
 *
 * Only stores whose values mean the same on another computer are listed. Excluded on
 * purpose: absolute paths (chat folder, terminal shell, Android adb, browser profile),
 * hardware ids (microphone, gamepads), machine-generated keys, security grants handled
 * separately (remote control), consent stores with their own lifecycle (analytics, log
 * upload), stores with migration side effects (chat embedding, Pi compaction, model context
 * limits) and teammate model chains, which by rule do not move between computers.
 */
import type { PortableOverrideSettings } from '../maker-host/override-settings-file.js';
import { appearancePortableSettings } from '../appearance-settings-store.js';
import { autoUpdatePortableSettings } from '../auto-update-settings-store.js';
import { menubarPortableSettings } from '../menubar/settingsStore.js';
import { agentResourcePortableSettings } from '../maker-host/agent-resource-settings-store.js';
import { collaborationPortableSettings } from '../maker-host/collaboration-settings-store.js';
import { compactionPortableSettings } from '../maker-host/compaction-settings-store.js';
import { gitSafetyPortableSettings } from '../maker-host/git-safety-settings-store.js';
import { goalPortableSettings } from '../maker-host/goal-settings-store.js';
import { memoryPortableSettings } from '../maker-host/memory-settings-store.js';
import { modelCatalogOverridePortableSettings } from '../maker-host/model-catalog-override-store.js';
import { modelDisablePortableSettings } from '../maker-host/model-disable-store.js';
import { providerOrderPortableSettings } from '../maker-host/provider-order-store.js';
import { sessionRuntimeFallbackPortableSettings } from '../maker-host/session-runtime-fallback-store.js';
import { silentEncryptedRetryPortableSettings } from '../maker-host/silent-encrypted-retry-store.js';
import { silentStopAutoResumePortableSettings } from '../maker-host/silent-stop-auto-resume-store.js';
import { subagentModelPortableSettings } from '../maker-host/subagent-model-settings-store.js';
import { updateChannelPortableSettings } from '../updateChannelStore.js';
import { modelPriceOverridePortableSettings } from '../usage/modelPriceOverrideStore.js';
import { auxiliaryModelPortableSettings } from '../utility-model/auxiliary-model-settings-store.js';
import { visionBridgePortableSettings } from '../vision-bridge/vision-bridge-settings-store.js';
import { windowBehaviorPortableSettings } from '../window-behavior-settings-store.js';

export interface SetupSettingsGroup {
  /** Stable wire id; the renderer owns its label (`setupMigration.settingsGroups.<id>`). */
  id: string;
  /** Only copied between computers of these platforms. */
  platforms?: readonly NodeJS.Platform[];
  settings: PortableOverrideSettings;
}

export const SETUP_SETTINGS_GROUPS: readonly SetupSettingsGroup[] = [
  { id: 'appearance', settings: appearancePortableSettings },
  { id: 'windowBehavior', settings: windowBehaviorPortableSettings },
  { id: 'menubar', platforms: ['darwin'], settings: menubarPortableSettings },
  { id: 'collaboration', settings: collaborationPortableSettings },
  { id: 'agentResource', settings: agentResourcePortableSettings },
  { id: 'gitSafety', settings: gitSafetyPortableSettings },
  { id: 'goal', settings: goalPortableSettings },
  { id: 'memory', settings: memoryPortableSettings },
  { id: 'compaction', settings: compactionPortableSettings },
  { id: 'silentEncryptedRetry', settings: silentEncryptedRetryPortableSettings },
  { id: 'silentStopAutoResume', settings: silentStopAutoResumePortableSettings },
  { id: 'sessionRuntimeFallback', settings: sessionRuntimeFallbackPortableSettings },
  { id: 'subagentModels', settings: subagentModelPortableSettings },
  { id: 'auxiliaryModels', settings: auxiliaryModelPortableSettings },
  { id: 'visionBridge', settings: visionBridgePortableSettings },
  { id: 'modelVisibility', settings: modelDisablePortableSettings },
  { id: 'providerOrder', settings: providerOrderPortableSettings },
  { id: 'modelCatalogOverrides', settings: modelCatalogOverridePortableSettings },
  { id: 'modelPriceOverrides', settings: modelPriceOverridePortableSettings },
  { id: 'autoUpdate', settings: autoUpdatePortableSettings },
  { id: 'updateChannel', settings: updateChannelPortableSettings },
];
