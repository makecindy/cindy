const connections = [
  { id: 'grant-notes', name: 'Notes', clientId: 'org.example.notes' },
  { id: 'grant-board', name: 'Board', clientId: 'org.example.board' },
];

export default {
  name: 'local-agent', entry: './local-agent-fixture.tsx', viewport: { width: 900, height: 650 },
  real: 'LocalAgentSection, standard settings rows and themed Button',
  notCovered: 'Native consent, IPC authentication and actual grant revocation; these require isolated Desktop and protocol integration checks.',
  cases: {
    'dev-ready': { about: 'Copy the current development endpoint', data: { developer: { state: 'ready', code: 'cindy-local:v1:12345:' + 'n'.repeat(43) } } },
    'copy-failed': { about: 'Clipboard failure remains visible without claiming a copy', data: { copyFailed: true, developer: { state: 'ready', code: 'cindy-local:v1:12345:' + 'n'.repeat(43) } } },
    'copy-expired': { about: 'Click refresh prevents copying a retired endpoint', data: { copyExpired: true, developer: { state: 'ready', code: 'cindy-local:v1:12345:' + 'n'.repeat(43) } } },
    'dev-starting': { about: 'Starting API cannot supply a code', data: { developer: { state: 'starting' } } },
    'dev-owner': { about: 'Owner unavailable cannot supply a code', data: { developer: { state: 'owner-unavailable' } } },
    'dev-in-use': { about: 'Shared profile lease is owned by another process', viewport: { width: 390, height: 844 }, data: { developer: { state: 'host-in-use' } } },
    'dev-failed': { about: 'API startup failure cannot supply a code', data: { developer: { state: 'failed' } } },
    'dev-stopped': { about: 'Stopped API cannot supply a code', data: { developer: { state: 'stopped' } } },
    default: { about: 'Revoke one application and retain the other row', data: { connections } },
    long: { about: 'Long unverified application names and IDs at phone width', viewport: { width: 390, height: 844 }, data: { connections: [
      { id: 'grant-long', name: 'Independent application with a long name 独立本机应用程序', clientId: 'org.example.an.independent.application.with.a.long.identifier' }, connections[1],
    ] } },
    empty: { about: 'No application is connected', data: { connections: [] } },
    'read-failed': { about: 'Connection read error remains visible', data: { loadFailed: true } },
    cancelled: { about: 'Cancelling native confirmation retains both applications', data: { connections, cancel: true } },
    'revoke-failed': { about: 'Failed revocation retains both applications and offers retry', data: { connections, revokeFailed: true } },
  },
  async check(page, ui) {
    const heading = page.getByRole('heading', { name: await ui.t('localAgent.title') });
    await heading.waitFor();
    const copy = page.getByRole('button', { name: await ui.t('localAgent.copyCode'), exact: true });
    if (ui.data.developer) {
      await copy.waitFor();
      if (ui.data.developer.state !== 'ready') {
        if (await copy.isEnabled()) throw new Error('Unavailable endpoint is copyable');
        await page.getByText(await ui.t(`localAgent.developerState.${ui.data.developer.state}`), { exact: true }).waitFor();
      } else {
        await page.evaluate((fail) => {
          window.__copyRequested = true;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => {
            if (fail) throw new Error('clipboard denied');
            window.__copiedCode = value;
          } } });
        }, Boolean(ui.data.copyFailed));
        await copy.click();
        if (ui.data.copyExpired) {
          await page.getByText(await ui.t('localAgent.developerState.stopped'), { exact: true }).waitFor();
          if (await page.evaluate(() => Boolean(window.__copiedCode))) throw new Error('Copied expired endpoint');
        } else if (ui.data.copyFailed) {
          await page.getByText(await ui.t('localAgent.codeCopyFailed'), { exact: true }).waitFor();
          if (await page.evaluate(() => Boolean(window.__copiedCode))) throw new Error('Claimed failed copy');
        } else {
          await page.getByText(await ui.t('localAgent.codeCopied'), { exact: true }).waitFor();
          if (await page.evaluate(() => window.__copiedCode) !== ui.data.developer.code) throw new Error('Wrong connection code');
        }
      }
    } else if (await copy.count()) throw new Error('Installed build exposes development entry');
    const list = ui.data.connections ?? [];
    if (!list.length) {
      await page.getByText(await ui.t(ui.data.loadFailed ? 'localAgent.failed' : 'localAgent.empty'), { exact: true }).waitFor();
      return;
    }
    await page.getByText(list[0].clientId, { exact: false }).waitFor();
    await page.getByRole('button', { name: await ui.t('localAgent.revokeConnection', { app: list[0].name }), exact: true }).click();
    if (ui.data.cancel || ui.data.revokeFailed) await page.getByText(list[0].clientId, { exact: false }).waitFor();
    else await page.getByText(list[0].clientId, { exact: false }).waitFor({ state: 'detached' });
    await page.getByText(list[1].clientId, { exact: false }).waitFor();
  },
};
