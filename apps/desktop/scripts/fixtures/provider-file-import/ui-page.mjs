export default {
  name: 'provider-file-import',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 700 },
  real: 'ProviderImportFileButton and the existing ProviderImportDialog with a large catalog preview',
  notCovered: 'Native file picker, file I/O, credentials, persistence and account changes (covered by IPC tests); preview data is synthetic',
  cases: {
    default: { about: 'Read the guide and expandable format help, find example downloads, review 257 models, then cancel' },
    batch: { about: 'Review three providers, import two API-key entries, retry only the failed entry and leave OAuth for individual consent' },
  },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('settings.providers.import.fromFile') }).click();
    await ui.capture('guide');
    await page.getByRole('button', { name: await ui.t('settings.providers.import.showFormat') }).click();
    await ui.capture('format');
    await page.getByRole('link', { name: await ui.t('settings.providers.import.downloadExample'), exact: true }).waitFor();
    await page.getByRole('link', { name: await ui.t('settings.providers.import.downloadBatchExample'), exact: true }).waitFor();
    await page.getByRole('button', { name: await ui.t('settings.providers.import.selectJsonFile') }).click();
    if (ui.case === 'batch') {
      await page.getByRole('checkbox', { name: 'Example a' }).waitFor();
      await ui.capture('batch-review');
      await page.getByRole('button', { name: await ui.t('settings.providers.import.batchImport', { count: 2 }) }).click();
      await page.getByText(await ui.t('settings.providers.import.batchStatus.failed'), { exact: true }).waitFor();
      await ui.capture('batch-partial');
      await page.getByRole('button', { name: await ui.t('settings.providers.import.batchImport', { count: 1 }) }).click();
      await page.getByText(await ui.t('settings.providers.import.batchStatus.failed'), { exact: true }).waitFor({ state: 'hidden' });
      await ui.capture('batch-retried');
      await page.getByRole('button', { name: await ui.t('common.dismiss'), exact: true }).click();
      return;
    }
    await page.getByText('Example model catalog', { exact: true }).waitFor();
    await ui.capture('review');
    await page.getByRole('button', { name: await ui.t('settings.providers.import.cancel'), exact: true }).click();
    await page.getByText('Example model catalog', { exact: true }).waitFor({ state: 'hidden' });
  },
};
