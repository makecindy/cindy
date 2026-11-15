export default {
  name: 'storage-settings',
  entry: './storage-settings-fixture.tsx',
  viewport: { width: 820, height: 1100 },
  real: 'StorageManagementCard: media cache rows, the manual database cleanup scan window, the database size warning and the automatic cleanup switch with its retention period',
  notCovered:
    'Actual scans, cleanup, relaunch, file dialogs and the settings file on disk; every value here is fixture data.',
  cases: {
    default: { about: 'Automatic cleanup on with a 30-day retention period' },
  },
  async ready(page) {
    await page.getByRole('heading').first().waitFor();
  },
  async check(page, ui) {
    const toggle = page.getByRole('switch', {
      name: await ui.t('settings.about.storage.dbAutoCleanupEnableLabel'),
    });
    await toggle.waitFor();
    // The shipped default is on, so the retention period must be editable.
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      throw new Error('automatic cleanup switch did not render as enabled');
    }
    const retention = page.getByRole('combobox', {
      name: await ui.t('settings.about.storage.dbAutoCleanupRetentionLabel'),
    });
    if (await retention.isDisabled()) {
      throw new Error('retention period is disabled while automatic cleanup is on');
    }
    // Crop to the block itself: the card is taller than the viewport and this is
    // the only region this page exists to show.
    await ui.capture('automatic-cleanup', {
      locator: page.locator('#settings-search-settings-about-storage-dbAutoCleanupTitle'),
    });
  },
};
