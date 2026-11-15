export default {
  name: 'session-import', entry: './import-fixture.tsx', viewport: { width: 900, height: 760 },
  real: 'SessionImportSection: source filter, search, project groups, hidden-record menu, selection footer, job progress and results, source marks',
  notCovered: 'Reading real tool histories, starting or cancelling imports, folder relocation and opening imported tasks; verified in the full isolated Desktop.',
  cases: {
    default: { about: 'Grouped candidates with a missing folder, an archived and an unsupported record' },
    empty: { about: 'Nothing importable: supported tools and rescan' },
    running: { about: 'Import in progress with queued and writing rows' },
    result: { about: 'Finished import: ready, needs a folder and failed rows' },
  },
  async ready(page) { await page.getByRole('heading').first().waitFor(); },
  async check(page, ui) {
    if (ui.case !== 'result') return;
    await ui.emit('progress', await page.evaluate(() => window.__importResult));
    await page.getByRole('button', { name: await ui.t('settings.sessionImport.result.done'), exact: true }).waitFor();
  },
};
