export default {
  name: 'automation-settings',
  entry: './automation-settings-fixture.tsx',
  viewport: { width: 900, height: 900 },
  real: 'ComputerUseSection, browser backend/settings controls, loading and error states, production themes and translations',
  notCovered: 'Native browser operations/queue, IPC transport, permissions, actual settings persistence and full Desktop runtime',
  cases: {
    default: { about: 'Resolved external browser detection, no local Chrome', data: {} },
    pending: { about: 'External status waits without hiding other settings or the backend choice', data: { probePending: true } },
    'config-pending': { about: 'Base configuration waits with a visible loading shell', data: { configPending: true } },
    'failed-retry': { about: 'Probe rejection stays distinct from missing Chrome and retries to a known result', data: { probeFailed: true }, viewport: { width: 460, height: 900 } },
    embedded: { about: 'External status waits while embedded browser settings remain usable', data: { probePending: true, embedded: true } },
  },
  async check(page, ui) {
    await page.getByRole('heading', { name: await ui.t('settings.computerUse.title'), exact: true }).waitFor();
    if (ui.data.configPending) {
      await page.getByText(await ui.t('settings.computerUse.loading'), { exact: true }).waitFor();
      return;
    }
    await page.getByText(await ui.t('settings.computerUse.android.title'), { exact: true }).waitFor();
    if (ui.data.probePending) {
      if (!ui.data.embedded) await page.getByText(await ui.t('settings.computerUse.browser.checking'), { exact: true }).waitFor();
      const backend = page.getByRole('radio', { name: await ui.t('settings.computerUse.browserBackend.rsbWebview.title'), exact: true });
      if (!await backend.isEnabled()) throw new Error('Browser probe blocked backend choice');
      if (await page.getByText(await ui.t('settings.computerUse.browser.download'), { exact: true }).count()) throw new Error('Pending detection claims Chrome is missing');
    } else if (ui.data.probeFailed) {
      await page.getByText(await ui.t('settings.computerUse.browser.statusFailed'), { exact: true }).waitFor();
      await ui.capture('probe-error');
      await page.getByRole('button', { name: await ui.t('commonUi.retry'), exact: true }).click();
      await page.getByText(await ui.t('settings.computerUse.browser.notDetected'), { exact: true }).waitFor();
    } else {
      await page.getByText(await ui.t('settings.computerUse.browser.notDetected'), { exact: true }).waitFor();
    }
  },
};
