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
        hint: null, retry: null, imDefaults: null, applyPatch: () => {},
      });
      export const WorkspacePrefsEditor = () => null;
    `,
  },
  cases: {
    'empty-apps': { about: 'No permitted bot: no stale account or linking action survives', data: { kind: 'empty-apps' } },
    'working-long-name': { about: 'Current computer hides selection; long remote computer name wraps at 360px', viewport: { width: 360, height: 1100 }, data: { kind: 'working-long-name' } },
    'org-only': { about: 'Store release gate closed: only the configured enterprise bot appears', data: { kind: 'org-only' } },
    'choose-bot': { about: 'No linked account: choose a named bot before authorization', data: { kind: 'choose-bot' } },
    'choose-bot-narrow': { about: 'Bot selection at 360px wraps badges and actions', viewport: { width: 360, height: 1100 }, data: { kind: 'choose-bot' } },
    'coexist-store-failed': { about: 'An additional store authorization fails while existing bot accounts remain usable', data: { kind: 'coexist-store-failed' } },
    'coexist-error': { about: 'Named bots retain explicit transport error details after a connection failure', data: { kind: 'coexist-error' } },
    coexist: { about: 'Both apps enabled: named bot cards share settings, separate accounts', data: { kind: 'coexist' } },
    'coexist-pending': { about: 'Additional store account authorizes while both bots stay linked', data: { kind: 'coexist-pending' } },
    'coexist-narrow': { about: 'Both apps at 360px: labels and actions wrap', viewport: { width: 360, height: 1100 }, data: { kind: 'coexist' } },
    store: { about: 'Store app: multiple linked accounts with the existing link action', data: { kind: 'store' } },
    'store-failed': { about: 'Failed additional authorization retains existing accounts and shows its error', data: { kind: 'store-failed' } },
    'store-pending': { about: 'Existing store accounts remain visible while another account authorizes', data: { kind: 'store-pending' } },
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
    assert.equal(await card.getByText(/org-example|tenant-acme|tenant-xd/).count(), 0);
    if (await card.getByRole('group', { name: '团队 Cindy', exact: true }).count()) {
      assert.ok(await card.getByText(`${await ui.t('settings.remoteControl.hook.feishu.appType.self_built')} · 飞书示例企业`, { exact: true }).isVisible());
    }
    if (ui.data.kind === 'empty-apps') {
      assert.equal(await card.getByText('Alice', { exact: true }).count(), 0);
      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.openBot'), exact: true }).count(), 0);
      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.connectBot'), exact: true }).count(), 0);
    }
    if (ui.data.kind === 'org-only') {
      assert.equal(await card.getByText('Cindy', { exact: true }).count(), 0);
      assert.equal(await card.getByRole('group', { name: '团队 Cindy', exact: true }).count(), 1);
      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.linkAnotherAccount'), exact: true }).count(), 0);
    }
    if (ui.data.kind === 'choose-bot') {
      assert.ok(await card.getByText(await ui.t('settings.remoteControl.hook.feishu.chooseBot'), { exact: true }).isVisible());
      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.connectBot'), exact: true }).count(), 2);
    }
    if (ui.data.kind === 'coexist-store-failed') {
      assert.ok(await card.getByText('Alice', { exact: true }).isVisible());
      assert.ok(await card.getByText('张三', { exact: true }).isVisible());
      assert.ok(await card.getByText(await ui.t('settings.remoteControl.hook.feishu.status.failed'), { exact: true }).isVisible());
      assert.ok(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.linkAnotherAccount'), exact: true }).isVisible());
    }
    if (ui.data.kind === 'coexist-error') assert.ok(await card.getByText('TLS connection failed', { exact: true }).isVisible());
    if (ui.data.kind === 'working-long-name' || ui.data.kind === 'coexist' || ui.data.kind === 'coexist-pending') {
      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.setWorkingDevice'), exact: true }).count(), 2);

      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.openBot'), exact: true }).count(), 2);
      assert.ok(await card.getByText('团队 Cindy', { exact: true }).isVisible());
      assert.ok(await card.getByText('Alice', { exact: true }).isVisible());
      assert.ok(await card.getByText(await ui.t('settings.remoteControl.hook.feishu.bridgeDescription'), { exact: true }).isVisible());
      // 项目与模型不在渠道卡里(整页只有一处, 所有官方机器人共用)。
      assert.equal(await card.getByRole('radio').count(), 0);
      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.unlink'), exact: true }).count(), 3);
    }
    if (ui.data.kind === 'store' || ui.data.kind === 'store-pending' || ui.data.kind === 'store-failed') {
      assert.ok(await card.getByText('Alice', { exact: true }).isVisible());
      assert.ok(await card.getByText('Bob', { exact: true }).isVisible());
      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.unlink'), exact: true }).count(), 2);
      if (ui.data.kind === 'store') assert.ok(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.connect'), exact: true }).isVisible());
      if (ui.data.kind === 'store-failed') assert.ok(await card.getByText(await ui.t('settings.remoteControl.hook.feishu.status.failed'), { exact: true }).isVisible());
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
    if (ui.data.kind === 'confirmed') {
      assert.equal(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.feishu.setWorkingDevice'), exact: true }).count(), 0);
      assert.ok(await card.getByText('Cindy MacBook', { exact: false }).isVisible());
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
