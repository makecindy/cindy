import assert from 'node:assert/strict';

export default {
  name: 'ssh-agent-diagnostics',
  entry: './fixture.tsx',
  viewport: { width: 1060, height: 760 },
  real: 'RemoteSection, SSH key unlock/recovery dialogs, localized agent diagnostics',
  notCovered: 'Real SSH/ssh-agent, credentials, service installation, persistence and remote agents',
  cases: {
    default: { about: 'Imported host explains local ssh-agent versus terminal ssh' },
    'agent-unavailable': { about: 'Local agent failure has actionable host-row and toast guidance' },
    'agent-configured-unset': { about: 'Unset IdentityAgent environment variable remains visible in the row and toast' },
    'agent-configured-empty': { about: 'Empty IdentityAgent endpoint remains visible in the row and toast' },
    'agent-configured-unavailable': { about: 'Unavailable configured endpoint is distinguished from the default agent' },
    'agent-recovery': { about: 'Key management recovery shows commands and accurate direct-key limitations' },
  },
  async check(page, ui) {
    const hint = page.getByText(await ui.t('settings.remote.importedAgentHint'), { exact: true });
    await page.getByText('build-server', { exact: true }).waitFor();
    if (ui.case === 'agent-unavailable' || ui.case.startsWith('agent-configured-')) {
      const errorKey = {
        'agent-configured-unset': 'settings.remote.agentError.environmentUnset',
        'agent-configured-empty': 'settings.remote.agentError.endpointEmpty',
        'agent-configured-unavailable': 'settings.remote.agentError.endpointUnavailable',
      }[ui.case] ?? 'ipcError.SSH_AGENT_UNAVAILABLE';
      await page.getByRole('button', { name: await ui.t('settings.remote.button.connect'), exact: true }).click();
      await ui.emit('sshStatus', {
        config: {
          id: 'build-server', hostname: 'build.example.com', user: 'developer', port: 22,
          authMethod: 'agent', source: 'ssh-config', managedByCindy: false,
          identityFileConfigured: true, identityFileName: 'id_ed25519',
        },
        status: 'failed', lastError: await ui.t(errorKey),
        statusChangedAt: 0, autoConnect: false, agentProxy: null, agentProxyTunnel: null,
      });
      const message = page.getByText(await ui.t(errorKey), { exact: true });
      // One copy in the host row; another comes through the real IPC-to-toast mapping.
      await message.nth(1).waitFor();
      assert.equal(await message.count(), 2);
    } else if (ui.case === 'agent-recovery') {
      await page.getByRole('button', { name: await ui.t('settings.remote.button.manageKeys'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('settings.remote.keys.unlockButton'), exact: true }).click();
      const unlock = page.getByRole('dialog', { name: await ui.t('settings.remote.keys.unlockTitle', { name: 'example_key' }), exact: true });
      await unlock.getByLabel(await ui.t('settings.remote.keys.passLabel'), { exact: true }).fill('scenario-only');
      await unlock.getByRole('button', { name: await ui.t('settings.remote.keys.unlockSubmit'), exact: true }).click();
      await page.getByRole('dialog', { name: await ui.t('settings.remote.keys.agentTrouble.title'), exact: true }).waitFor();
      assert.equal(await page.getByText(await ui.t('settings.remote.keys.agentTrouble.fallbackBody'), { exact: true }).count(), 1);
      await page.getByText('ssh-add -l', { exact: true }).waitFor();
    }
    assert.equal(await hint.count(), 1);
  },
};
