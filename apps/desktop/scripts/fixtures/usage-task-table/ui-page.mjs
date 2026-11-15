export default {
  name: 'usage-task-table',
  entry: './usage-task-table-fixture.tsx',
  viewport: { width: 1100, height: 320 },
  real: 'UsageTaskTable, current model/provider column labels, translations and themes',
  notCovered: 'Usage collection, model switching and navigation to live tasks',
  cases: { default: { about: 'Historical token total next to the current task configuration' } },
  async ready(page) { await page.getByRole('table').waitFor(); },
};
