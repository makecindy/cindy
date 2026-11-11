export default {
  name: 'provider-group-rebalance',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 640 },
  real: 'SessionRebalanceChoices, offerSessionRebalance and shared ConfirmDialogProvider',
  notCovered: 'Real message delivery, persistence and cross-device calls; covered by targeted tests',
  cases: {
    default: { about: 'Choose once, automatic or off before sending' },
    'long-name': { about: 'Long computer and account name' },
  },
  async ready(page) {
    await page.getByRole('alertdialog').waitFor();
  },
};
