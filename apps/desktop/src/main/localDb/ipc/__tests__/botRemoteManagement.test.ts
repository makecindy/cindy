/**
 * unit: invoke the production management host, not a separately assembled test host.
 * Regression: a connected recipient existed, but the composition omitted deliveryTargets.
 * Minimal input: one authorized controller asks for one visible teammate's recipients.
 * Existing host/renderer tests injected the callback and could not detect this omission.
 */
import { expect, it, vi } from 'vitest';
import { BOT_SETTINGS_ACTION_ID } from '../../../../shared/botRemoteSettings.js';

const h = vi.hoisted(() => ({
  targets: [{ id: 'connected-recipient', channel: 'telegram', name: 'Reports bot', recipient: 'Owner' }],
  deliveryTargets: vi.fn(),
}));
vi.mock('../../../routines/service.js', () => ({ routineTools: { deliveryTargets: h.deliveryTargets } }));
vi.mock('../../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false }));
vi.mock('../../../device-link/settings-store.js', () => ({ readDeviceLinkSettings: () => ({ remoteControlEnabled: true, revokedControllers: [] }) }));
vi.mock('../botRemoteSessionAccess.js', () => ({ readRemoteBotSessionAccess: async () => 'visible' }));
// These services belong to other settings pages and must not initialize for a recipient query.
vi.mock('../../../bot-autonomy/hub.js', () => ({ getBotAutonomySettingsView: vi.fn(), resetBotAutonomySchedulerSettings: vi.fn(), setBotAutonomySchedulerBotId: vi.fn() }));
vi.mock('../../../maker-host/bot-model-chain-settings-store.js', () => ({ readEffectiveBotModelChain: vi.fn() }));
vi.mock('../../../maker-ipc/appDefaultModelControl.js', () => ({ resolveAvailableTaskModels: vi.fn() }));
vi.mock('../bots.js', () => ({ createBotProfile: vi.fn(), createBotCanonicalSession: vi.fn(), getBotMemoryService: vi.fn(), getBotRemoteResourceSource: vi.fn(), getBotRemoteSettingsSource: vi.fn(), readBotSettingsProfile: vi.fn(), searchBotHistory: vi.fn(), setBotProfileAvatar: vi.fn(), updateBotProfile: vi.fn() }));
vi.mock('../../../maker-ipc/botSkillService.js', () => ({ listBotSkillsForBot: vi.fn(), readBotSkillForBot: vi.fn(), saveBotSkillForSession: vi.fn(), deleteBotSkillForBot: vi.fn() }));
vi.mock('../../../maker-ipc/botRuntimeEpochRefreshSignal.js', () => ({ requestBotRuntimeEpochRefresh: vi.fn() }));
vi.mock('../../../maker-ipc/botLifecycleService.js', () => ({ runRegisteredBotLifecycleAction: vi.fn() }));
vi.mock('../../../maker-host/index.js', () => ({ listBotSettingsCapabilities: vi.fn(), validateBotCapabilityAdditions: vi.fn() }));
vi.mock('../../../maker-ipc/botLinkedProjects.js', () => ({ botLinkedProjectAccess: vi.fn() }));
vi.mock('../botRemoteResourceProjection.js', () => ({ botRemoteResourceFromSource: vi.fn() }));
vi.mock('../botAvatarSelection.js', () => ({ decodeBotAvatarImage: vi.fn() }));
vi.mock('../botRemoteSettingsResource.js', () => ({ createBotRemoteSettingsResource: () => ({ bindResource: vi.fn() }) }));
vi.mock('../botRemoteEditors.js', () => ({ createBotRemoteEditors: vi.fn() }));

import { botRemoteManagement } from '../botRemoteManagement.js';

it('returns connected recipients through the actual remote management composition', async () => {
  h.deliveryTargets.mockResolvedValue(h.targets);
  const response = await botRemoteManagement.settingsHost.invoke({ controllerDeviceId: 'remote-desktop' }, {
    collectionId: 'teammates', resourceRef: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
    actionId: BOT_SETTINGS_ACTION_ID, client: { protocolVersion: 1, primitives: [] },
    input: { v: 1, op: 'routines.deliveryTargets' },
  });
  expect(response.result).toEqual({ ok: true, value: h.targets });
  expect(h.deliveryTargets).toHaveBeenCalledExactlyOnceWith('bot-1');
});
