import assert from 'node:assert/strict';

// Fixture data only: tool counts, agent and computer names are generic examples.
const tasks = [
  { source: 'claude', count: 42, mb: 380 },
  { source: 'codex', count: 17, mb: 96 },
  { source: 'cursor', count: 6, mb: 12 },
];
const companions = [
  { id: 'openclaw:main', kind: 'openclaw', name: 'Atlas' },
  { id: 'hermes:default', kind: 'hermes', name: 'Hermes' },
];
const fresh = { manual: false, migration: false, legacyMigrated: false };

async function next(page, ui, key = 'firstRunGuide.next') {
  await page.getByRole('button', { name: await ui.t(key), exact: true }).click();
}

export default {
  name: 'first-run-guide',
  entry: './first-run-guide-fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'FirstRunGuide (step selection, the cover and every step page, the parked bar), useProviderOnboarding rows inside the model step, FirstRunGuideSection, translations and themes',
  notCovered: 'Main-side once-only decision and reading other computers (unit-tested in src/main/setup-migration), the sign-in trigger and its wait for earlier-version data (SetupMigrationHost test), the Migration Assistant, provider wizard, task import page and teammate import form that the steps hand off to, real provider/session data and a real first sign-in',
  stubs: {
    'src/renderer/contexts/AuthContext': "export const useAuth = () => ({ mode: 'cloud', dataOwnerId: 'fixture', isAuthenticated: true, isInitializing: false, user: { membershipKind: 'personal' }, exitLocalMode: async () => {} });",
    'src/renderer/components/settings/useProviderSubscriptionCard': "export const useProviderSubscriptionCard = (provider) => (provider?.connected ? { identity: 'alex@example.com', planLabel: 'Pro', windows: [] } : null);",
    'src/renderer/hooks/useProviders': 'export const useProviders = () => ({ providers: window.__guideProviders, providerOrder: [], ownerGeneration: 0, loading: false, error: null, loadFailed: false, refetch: async () => true });',
  },
  cases: {
    default: { about: 'A new user on a new computer starts with what Cindy is', data: { context: fresh, tasks, companions } },
    models: { about: 'Give Cindy a model: what the official service offers, and using your own plan alongside it', data: { context: fresh, tasks, companions } },
    'models-connected': {
      about: 'A provider that is already connected leads the list as a row with its account and plan',
      data: { context: { ...fresh, manual: true }, connected: true, ownConnected: true },
    },
    'models-paid': {
      about: 'A paying account sees its available balance, with the gifted part named separately',
      data: {
        context: { ...fresh, manual: true }, connected: true,
        balance: { planCredits: '18.250000000', purchasedCredits: '0', promotionalCredits: '1.500000000', available: '19.750000000', scale: 9, observedAt: '2026-11-11T00:00:00.000Z' },
      },
    },
    import: { about: 'Tasks of other AI tools grouped by tool, and agents that can become teammates', data: { context: fresh, tasks, companions } },
    finish: { about: 'Summary after the steps, with the note that skills and MCP need no import', data: { context: fresh, tasks, companions, connected: true } },
    migration: { about: 'A returning user leads with the Migration Assistant and is not introduced to Cindy again', data: { context: { ...fresh, migration: true } } },
    legacy: { about: 'Right after earlier-version data was brought over, the guide lists it first', data: { context: { ...fresh, legacyMigrated: true }, connected: true, lastRun: null } },
    walkthrough: { about: 'The whole new-user path in order: meet Cindy, leave to connect a model and come back, import tasks, finish', data: { context: fresh, tasks, companions } },
    parked: { about: 'While a step is finished on another page, a small bar offers the way back', data: { context: fresh, parked: true } },
    settings: { about: 'Settings → General entry that reopens the guide with every step', data: { surface: 'settings', tasks }, viewport: { width: 900, height: 760 } },
  },
  async check(page, ui) {
    if (ui.case === 'settings') {
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.getByRole('button', { name: await ui.t('firstRunGuide.settings.open'), exact: true }).click();
      await page.getByText(await ui.t('firstRunGuide.intro.lead'), { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'parked') {
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.getByRole('button', { name: await ui.t('firstRunGuide.resume.back'), exact: true }).click();
      await page.getByRole('dialog').waitFor();
      return;
    }
    if (ui.case === 'models-connected') {
      await next(page, ui, 'firstRunGuide.intro.start');
      await next(page, ui, 'firstRunGuide.skip');
      await page.getByText('alex@example.com · Pro', { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'models-paid') {
      // Opened by hand: intro, then migration, then the model step.
      await next(page, ui, 'firstRunGuide.intro.start');
      await next(page, ui, 'firstRunGuide.skip');
      await page.getByText(await ui.t('billing.balance.title'), { exact: false }).first().waitFor();
      assert.equal(await page.getByText(await ui.t('firstRunGuide.models.cindy.freeBalance'), { exact: true }).count(), 0);
      return;
    }
    if (ui.case === 'migration') {
      await page.getByText(await ui.t('firstRunGuide.migration.title'), { exact: true }).waitFor();
      assert.equal(await page.getByText(await ui.t('firstRunGuide.intro.lead'), { exact: true }).count(), 0);
      return;
    }
    if (ui.case === 'legacy') {
      await page.getByText(await ui.t('firstRunGuide.legacy.title'), { exact: true }).waitFor();
      return;
    }
    await page.getByText(await ui.t('firstRunGuide.intro.lead'), { exact: true }).waitFor();
    if (ui.case === 'default') return;
    const start = () => next(page, ui, 'firstRunGuide.intro.start');
    const modelsTitle = page.getByText(await ui.t('firstRunGuide.models.title'), { exact: true });
    if (ui.case === 'walkthrough') {
      await ui.capture('1-intro');
      await start();
      await modelsTitle.waitFor();
      await ui.capture('2-models');
      // Choosing a way to connect leads to its own page; the guide steps aside and leaves a way back.
      await page.getByText('OpenAI', { exact: true }).click();
      await page.getByRole('button', { name: await ui.t('firstRunGuide.resume.back'), exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      await ui.capture('3-models-parked');
      await page.getByRole('button', { name: await ui.t('firstRunGuide.resume.back'), exact: true }).click();
      await next(page, ui, 'firstRunGuide.skip');
      await page.getByLabel('Claude Code').check();
      await ui.capture('4-import');
      await page.getByRole('button', { name: await ui.t('settings.sessionImport.importCount', { count: 42 }), exact: true }).click();
      await page.getByText(await ui.t('firstRunGuide.import.started'), { exact: true }).waitFor();
      await ui.capture('5-import-started');
      await next(page, ui);
      await page.getByText(await ui.t('firstRunGuide.finish.importStarted'), { exact: true }).waitFor();
      return;
    }
    await start();
    await modelsTitle.waitFor();
    if (ui.case === 'finish') {
      // The official service comes with the account, so the step is already settled.
      await page.getByText(await ui.t('firstRunGuide.models.cindy.freeBalance'), { exact: true }).waitFor();
      await ui.capture('models-ready');
      await next(page, ui);
      await page.getByText(await ui.t('firstRunGuide.import.title'), { exact: true }).waitFor();
      await next(page, ui, 'firstRunGuide.skip');
      await page.getByText(await ui.t('firstRunGuide.finish.native'), { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'models') {
      await page.getByText(await ui.t('firstRunGuide.models.cindy.freeBalance'), { exact: true }).waitFor();
      return;
    }
    await next(page, ui, 'firstRunGuide.skip');
    await page.getByText('Claude Code', { exact: true }).waitFor();
    await page.getByLabel('Claude Code').check();
    await page.getByRole('button', { name: await ui.t('settings.sessionImport.importCount', { count: 42 }), exact: true }).waitFor();
  },
};
