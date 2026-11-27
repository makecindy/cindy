import assert from 'node:assert/strict';

export default {
  name: 'official-discord-card',
  entry: './fixture.tsx',
  viewport: { width: 720, height: 760 },
  real: 'HookConnectionsSection official Discord card, ImChannelSettingsCard, Button, Switch and translated status text',
  notCovered:
    'Workspace preference editor (stubbed), live hook IPC, binding requests and clipboard; binding state machine, link validation and dispatch checks have main-process unit tests',
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
    default: { about: 'Pending link: the one-time code with copy comes before the add-app actions', data: { kind: 'pending' } },
    narrow: { about: 'Pending link at 360px: code, guidance and actions wrap', viewport: { width: 360, height: 900 }, data: { kind: 'pending' } },
    awaiting: { about: 'The code was claimed by an account already linked elsewhere: confirm in Discord or cancel', data: { kind: 'awaiting' } },
    confirmed: { about: 'Linked: Discord account in the summary, open bot / add to server / unlink', data: { kind: 'confirmed' } },
    'confirmed-narrow': { about: 'Linked at 360px: actions wrap', viewport: { width: 360, height: 900 }, data: { kind: 'confirmed' } },
    disabled: { about: 'Endpoint configured but switched off: hint to turn it on', data: { kind: 'disabled' } },
    unavailable: { about: 'Server has not enabled provider:discord yet', data: { kind: 'unavailable' } },
  },
  async ready(page) {
    await page.locator('#cindy-im-discord-panel').waitFor();
  },
  async check(page, ui) {
    const card = page.locator('#cindy-im-discord-panel');
    const row = page.locator('#cindy-im-discord');
    if (ui.data.kind === 'pending') {
      const code = card.getByText('K7Q4-M2XD', { exact: true });
      const addApp = card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.discord.openApp'), exact: true });
      assert.ok(await code.isVisible());
      assert.ok(await addApp.isVisible());
      assert.ok(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.discord.bindCode.copy'), exact: true }).isVisible());
      assert.ok(await card.getByText(await ui.t('settings.remoteControl.hook.discord.bindCode.hint'), { exact: true }).isVisible());
      const codeBox = await code.boundingBox();
      const addBox = await addApp.boundingBox();
      assert.ok(codeBox && addBox && codeBox.y < addBox.y, 'the link code is the primary path and sits above the actions');
    }
    if (ui.data.kind === 'awaiting') {
      assert.equal(await card.getByText('K7Q4-M2XD', { exact: true }).count(), 0);
      assert.ok(await card.getByRole('button', { name: await ui.t('settings.remoteControl.hook.discord.cancel'), exact: true }).isVisible());
    }
    if (ui.data.kind === 'confirmed') {
      assert.ok((await row.textContent())?.includes('cindy_user'));
      for (const key of ['openBot', 'addToGroup', 'unlink']) {
        assert.ok(await card.getByRole('button', { name: await ui.t(`settings.remoteControl.hook.discord.${key}`), exact: true }).isVisible());
      }
    }
    if (ui.data.kind === 'disabled') {
      assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), 'false');
      assert.ok(await card.getByText(await ui.t('settings.remoteControl.hook.discord.disabledHint'), { exact: true }).isVisible());
    }
    if (ui.data.kind === 'unavailable') {
      assert.equal(await row.getByRole('status').textContent(), await ui.t('settings.remoteControl.hook.discord.status.unavailable'));
    }
  },
};
