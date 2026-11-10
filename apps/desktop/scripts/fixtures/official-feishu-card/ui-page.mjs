import assert from 'node:assert/strict';

export default {
  name: 'official-feishu-card',
  entry: './fixture.tsx',
  viewport: { width: 720, height: 900 },
  real: 'HookConnectionsSection official Feishu / Lark card, ImChannelSettingsCard, Button, Switch and translated status text',
  notCovered:
    'Workspace preference editor (stubbed), live hook IPC, binding requests and clipboard; binding state machine and URL validation have main-process unit tests',
  stubs: {
    'src/renderer/components/settings/HookWorkspacePrefsEditor': `
      export const useHookWorkspacePrefs = () => ({
        reloadImDefaults: async () => {}, prefsFor: () => null, providerSourceFor: () => null,
        agentDeviceFor: () => null, applyProviderSource: () => {}, editable: false, pendingWs: null,
        hint: null, retry: null, imDefaults: null, applyPatch: () => {}, teams: [],
        selectedTeamId: null, selectTeam: () => {}, showTeamChip: false,
      });
      export const WorkspacePrefsEditor = () => null;
    `,
  },
  cases: {
    bots: { about: 'Several bots with account identities and local notes', data: { kind: 'bots' } },
    'bots-pending': { about: 'Link an account to the chosen bot while other bots stay usable', data: { kind: 'bots-pending' } },
    multi: { about: 'Multiple identities share one computer with per-account unlink and working-device selection', data: { kind: 'multi' } },
    'multi-pending': { about: 'Additive linking preserves existing account rows', data: { kind: 'multi-pending' } },
    default: {
      about: 'Pending bind: authorize-page actions plus the one-time link code with copy',
      data: { kind: 'pending' },
    },
    unavailable: {
      about: 'Server lacks provider:feishu: the organization has not set up the bot',
      data: { kind: 'unavailable' },
    },
    unlinked: { about: 'Unlinked account with a live server socket: unbound badge and relink action', data: { kind: 'revoked' } },
    released: { about: 'Unlink acknowledged: connection released and switch off; enable again to link', data: { kind: 'released' } },
    confirmed: { about: 'Linked: open bot and unlink actions', data: { kind: 'confirmed' } },
    narrow: {
      about: 'Pending bind at 360px: code and actions wrap',
      viewport: { width: 360, height: 900 },
      data: { kind: 'pending' },
    },
  },
  async ready(page) {
    await page.locator('#cindy-im-feishu-panel').waitFor();
  },
  async check(page, ui) {
    const card = page.locator('#cindy-im-feishu-panel');
    if (ui.data.kind === 'bots' || ui.data.kind === 'bots-pending') {
      assert.equal(await card.getByRole('region').count(), 3);
      assert.ok(await card.getByText('Cindy · 合作伙伴', { exact: true }).isVisible());
      assert.equal(await card.getByRole('textbox').count(), 4);
      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.setWorkingDevice'), exact: true }).count(), 2);
      await ui.capture('bot-identity', { locator: card.getByRole('region').first() });
      if (ui.data.kind === 'bots-pending') {
        await card.getByRole('region', { name: 'Cindy · 项目团队' }).scrollIntoViewIfNeeded();
        await ui.capture('selected-bot-linking');
      }
    }
    if (ui.data.kind === 'released') {
      const row = page.locator('#cindy-im-feishu');
      assert.equal(await row.getByRole('status').textContent(), await ui.t('settings.remoteControl.hook.feishu.status.disabled'));
      assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), 'false');
      assert.equal(await card.getByText(await ui.t('settings.remoteControl.hook.feishu.status.revoked'), { exact: true }).count(), 0);
    }
    if (ui.data.kind === 'revoked') {
      const row = page.locator('#cindy-im-feishu');
      assert.equal(await row.getByRole('status').textContent(), await ui.t('settings.remoteControl.hook.feishu.status.none'));
      assert.ok(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.retry'), exact: true }).isVisible());
    }
    if (ui.data.kind === 'multi' || ui.data.kind === 'multi-pending') {
      assert.equal(await card.getByRole('group').count(), 4);
      assert.ok(await card.getByText('合作伙伴账号', { exact: true }).isVisible());
    }
    if (ui.data.kind === 'confirmed') {
      assert.ok(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.setWorkingDevice'), exact: true }).isVisible());
    }
    if (ui.data.kind === 'pending') {
      assert.ok(await card.getByText('7KQ4-M2XD', { exact: true }).isVisible());
      assert.ok(
        await card
          .getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.bindCode.copy'), exact: true })
          .isVisible(),
      );
    }
    if (ui.data.kind === 'unavailable') {
      assert.ok(
        await card
          .getByText(await ui.t('settings.remoteControl.hook.feishu.unavailableHint'), { exact: true })
          .isVisible(),
      );
    }
  },
};
