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
vi.mock('../../../maker-ipc/botSkillService.js', () => ({ listBotSkillsForBot: vi.fn(), readBotSkillForBot: vi.fn(), saveBotSkillForSession: vi.fn(), deleteBotSkillForBot: vi.fn(),
  readBotSkillSourceForBot: vi.fn(async () => '---\nname: report\n---\nSteps'), saveBotSkillSourceForBot: vi.fn(), setBotSkillEnabledForBot: vi.fn() }));
// The core Skill text pulls in the whole MCP package (~5 s to collect); no test here reads it.
vi.mock('../../../maker-ipc/teammateGuide.js', () => ({ buildTeammateGuide: vi.fn() }));
vi.mock('../../../maker-ipc/botRuntimeEpochRefreshSignal.js', () => ({ requestBotRuntimeEpochRefresh: vi.fn() }));
vi.mock('../../../maker-ipc/botLifecycleService.js', () => ({ runRegisteredBotLifecycleAction: vi.fn() }));
vi.mock('../../../maker-host/index.js', () => ({ listBotSettingsCapabilities: vi.fn(), validateBotCapabilityAdditions: vi.fn() }));
vi.mock('../../../maker-ipc/botLinkedProjects.js', () => ({ botLinkedProjectAccess: vi.fn() }));
vi.mock('../botRemoteResourceProjection.js', () => ({ botRemoteResourceFromSource: vi.fn() }));
vi.mock('../botAvatarSelection.js', () => ({ decodeBotAvatarImage: vi.fn() }));
vi.mock('../botRemoteSettingsResource.js', () => ({ createBotRemoteSettingsResource: () => ({ bindResource: vi.fn() }) }));
vi.mock('../botRemoteEditors.js', () => ({ createBotRemoteEditors: vi.fn() }));
vi.mock('../../../im/shared/botImConnectionRuntime.js', () => {
  const guestAccess = { unbound: 'refuse', bindings: { '555': { projectPath: '/Users/owner/clients/client-a' } } };
  const connection = (id: string) => ({ id, botId: 'bot-1', channel: 'telegram', guestAccess });
  return {
    buildBotImConnectionListPayload: () => ({ connections: [connection('mine'), connection('other')] }),
    removeBotImConnection: async () => ({ connections: [connection('other')], archivedSessionIds: [] }),
  };
});

import { botRemoteManagement } from '../botRemoteManagement.js';
import { createBotRemoteEditors } from '../botRemoteEditors.js';
import { getBotRemoteSettingsSource } from '../bots.js';
import { setBotSkillEnabledForBot } from '../../../maker-ipc/botSkillService.js';
import { requestBotRuntimeEpochRefresh } from '../../../maker-ipc/botRuntimeEpochRefreshSignal.js';

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

// Phone 「使用这个技能」 switch (cindy-bots-runtime.md §6「伙伴技能分层」). The editor tests inject this dependency, so only
// the composition shows the stored SKILL.md is moved unchanged and the teammate refreshes at its next turn.
// Minimal input: one learned skill turned off for a teammate with a main session. Unit, mocked services.
it('moves a learned skill to the disabled store and refreshes the teammate through the phone composition', async () => {
  vi.mocked(getBotRemoteSettingsSource).mockResolvedValue({ source: { canonicalSessionId: 'main-1' } } as never);
  const editorDeps = vi.mocked(createBotRemoteEditors).mock.calls[0][0];
  await editorDeps.setSkillEnabled('bot-1', 'report', false);
  expect(setBotSkillEnabledForBot).toHaveBeenCalledExactlyOnceWith('bot-1', 'report', false);
  expect(requestBotRuntimeEpochRefresh).toHaveBeenCalledExactlyOnceWith('main-1', 'resource');
});

// #8359 review: guest bindings (guest ids, local project paths) stay on this computer.
// The list already dropped them, but remove returned the remaining connections unfiltered.
// Minimal input: removing one connection while another of the same teammate has a binding.
it('keeps guest bindings out of every remote messaging-platform response', async () => {
  const call = (op: string, args?: unknown) => botRemoteManagement.settingsHost.invoke({ controllerDeviceId: 'remote-desktop' }, {
    collectionId: 'teammates', resourceRef: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' },
    actionId: BOT_SETTINGS_ACTION_ID, client: { protocolVersion: 1, primitives: [] },
    input: { v: 1, op, ...(args === undefined ? {} : { args }) },
  });
  for (const response of [await call('channels.im.list'), await call('channels.im.remove', { id: 'mine' })]) {
    expect(response.result).toMatchObject({ ok: true });
    expect(JSON.stringify(response.result)).not.toContain('client-a');
    expect(JSON.stringify(response.result)).not.toContain('guestAccess');
  }
});
