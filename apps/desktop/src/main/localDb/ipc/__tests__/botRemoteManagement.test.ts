/** unit: invoke the production management composition, not a separately assembled test host. */
import { expect, it, vi } from 'vitest';

vi.mock('../../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false }));
vi.mock('../../../device-link/settings-store.desktop.js', () => ({ readDeviceLinkSettings: () => ({ remoteControlEnabled: true, revokedControllers: [] }) }));
vi.mock('../botRemoteSessionAccess.js', () => ({ readRemoteBotSessionAccess: async () => 'visible' }));
// These services belong to other settings pages and must not initialize here.
vi.mock('../../../maker-host/bot-model-chain-settings-store.js', () => ({ readEffectiveBotModelChain: vi.fn() }));
vi.mock('../../../maker-ipc/appDefaultModelControl.js', () => ({ resolveAvailableTaskModels: vi.fn() }));
vi.mock('../bots.js', () => ({ botProjectRepository: vi.fn(), createBotProfile: vi.fn(), createBotCanonicalSession: vi.fn(), getBotMemoryService: vi.fn(), getBotRemoteResourceSource: vi.fn(), getBotRemoteSettingsSource: vi.fn(), readBotSettingsProfile: vi.fn(), searchBotHistory: vi.fn(), setBotProfileAvatar: vi.fn(), updateBotProfile: vi.fn() }));
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

import '../botRemoteManagement.js';
import { createBotRemoteEditors } from '../botRemoteEditors.js';
import { getBotRemoteSettingsSource } from '../bots.js';
import { setBotSkillEnabledForBot } from '../../../maker-ipc/botSkillService.js';
import { requestBotRuntimeEpochRefresh } from '../../../maker-ipc/botRuntimeEpochRefreshSignal.js';

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
