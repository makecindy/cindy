import { statfs } from 'node:fs/promises';
import { app } from 'electron';
import { storedCustomProviderId } from '@cindy/model-providers';
import { resolveProviderLogoKind, type ProviderLogoRouting } from '@cindy/model-providers/branding';
import { applyCustomModelEdit } from '../../shared/customModelEdit.js';
import * as authManager from '../authManager.js';
import { projectRoutingForDisplay, setCloudPrivateInvokeHandler } from '../device-link/dispatch.desktop.js';
import { callCloudManagement } from '../host-settings/managementCalls.js';
import { modelVisibilityRevision, setModelVisibility } from '../host-settings/modelPresentationDomains.js';
import { manageAppPreferences } from '../app-settings/preferences.js';
import { commitPersonalization, currentSettingsOwner, readPersonalization } from '../host-settings/personalization.js';
import { createLogger } from '../logger.js';
import { getCustomProvider } from '../maker-host/custom-provider-store.js';
import { activeDataOwnerId, ownerScopedPath } from '../ownerContext.js';
import { executeProviderShareGuestCommand } from '../device-link/providerShareRuntime.js';
import { cloudModelAccessControl } from '../model-access/index.js';
import { providerSecretStorageKey } from '../../shared/providerSecrets.js';
import { getInstanceConfig } from './config.js';
import { startCloudHandoverSettings } from './handoverSettings.js';
import { createProviderSettingsChannel } from './providerSettingsChannel.js';
import { createPersonalizationChannel } from './personalizationChannel.js';
import { createImSettingsChannel } from './imSettingsChannel.js';
import { createStorageUsageChannel } from './storageUsageChannel.js';
import { createProviderSetup, setProviderSetup } from './providerSetup.js';

/** Managed cloud instances only: the owner's cloud settings page manages providers, the prompt and IM settings, and reads storage usage over DeviceLink. */
export function registerCloudProviderSettings(): () => void {
  const instance = getInstanceConfig();
  if (!instance) return () => {};
  const isInstanceOwner = () =>
    getInstanceConfig()?.membershipId === instance.membershipId &&
    authManager.getCurrentUserId() === instance.membershipId;
  const setup = createProviderSetup(callCloudManagement);
  setProviderSetup({
    setup,
    owner: () => {
      const owner = isInstanceOwner() ? currentSettingsOwner() : null;
      return owner ? `${owner.dataOwnerId}:${owner.ownerGeneration}` : null;
    },
  });
  setCloudPrivateInvokeHandler(
    createProviderSettingsChannel({
      isInstanceOwner,
      owner: currentSettingsOwner,
      call: callCloudManagement,
      visibilityRevision: modelVisibilityRevision,
      async setVisibility(providerId, targets, enabled, assertCaller) {
        for (const target of targets) {
          await setModelVisibility({ harness: target.agent, providerId, modelId: target.modelId }, enabled);
          assertCaller();
        }
      },
      projectRouting: projectRoutingForDisplay,
      resolveLogoKind: (providerId, routing) =>
        resolveProviderLogoKind(providerId, routing as ProviderLogoRouting | undefined),
      // The window keeps per-model reasoning effort; this is the providers page's own setter.
      // A window that does not answer leaves the efforts shown as defaults rather than failing the whole list.
      readEfforts: async () => {
        try { return (await manageAppPreferences('model-effort')).modelEfforts ?? {}; }
        catch { return {}; }
      },
      applyEffort: async (modelEffort) => {
        await manageAppPreferences('model-effort', undefined, undefined, { modelEffort });
      },
      shareCommand: (command) => executeProviderShareGuestCommand(command),
      setup,
      modelAccess: cloudModelAccessControl,
      xdKey: providerSecretStorageKey('xd'),
      async editModel({ providerId, agent, modelId, edit }, execution) {
        const config = await getCustomProvider(storedCustomProviderId(providerId));
        execution.assertCurrent();
        if (!config) throw new Error('[NOT_FOUND] custom provider is gone');
        if (!applyCustomModelEdit(config, agent, modelId, edit))
          throw new Error('[INVALID_PARAMS] model edit does not apply');
        const result = (await callCloudManagement(
          'maker:provider:custom:update',
          [config, {}, { source: 'manual-settings' }],
          execution,
        )) as { ok?: unknown; confirmationRequired?: unknown } | null;
        if (result?.ok !== true)
          throw new Error(
            result?.confirmationRequired
              ? '[PRECONDITION_FAILED] the change waits for running tasks; retry later'
              : '[INTERNAL] the provider was not updated',
          );
      },
    }),
  );
  // The owner's cloud page edits the instance prompt like the local page (text stays on DeviceLink).
  setCloudPrivateInvokeHandler(
    createPersonalizationChannel({
      isInstanceOwner,
      owner: currentSettingsOwner,
      inspect: readPersonalization,
      commit: commitPersonalization,
    }),
  );
  // The local IM settings handlers for the owner's cloud IM cards (binding stays on tickets).
  setCloudPrivateInvokeHandler(
    createImSettingsChannel({
      isInstanceOwner,
      owner: currentSettingsOwner,
      call: (channel, args, execution) => callCloudManagement(channel, args, execution),
    }),
  );
  // Read-only storage totals and the instance disk for the owner's cloud storage page.
  setCloudPrivateInvokeHandler(
    createStorageUsageChannel({
      isInstanceOwner,
      owner: currentSettingsOwner,
      call: (channel, args, execution) => callCloudManagement(channel, args, execution),
      async disk() {
        const volume = await statfs(app.getPath('userData'));
        return { totalBytes: volume.blocks * volume.bsize, freeBytes: volume.bavail * volume.bsize };
      },
    }),
  );
  // The settings half of an instance handover: keep the owner's portable preferences where CIS
  // can pick them up, and take in what a handover left for this instance.
  const stopHandoverSettings = startCloudHandoverSettings({
    membershipId: instance.membershipId,
    activeOwnerId: activeDataOwnerId,
    ownerDirectory: () => ownerScopedPath(),
    userDataDirectory: () => app.getPath('userData'),
    warn: (message) => createLogger('instance-runtime').warn(message),
  });
  return () => {
    stopHandoverSettings();
    setCloudPrivateInvokeHandler(null);
    setProviderSetup(null);
  };
}
