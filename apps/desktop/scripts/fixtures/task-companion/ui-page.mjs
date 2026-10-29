import assert from 'node:assert/strict';
export default {
  name: 'task-companion', entry: './fixture.tsx', viewport: { width: 720, height: 800 },
  real: 'BotRosterView source-task fields; BotTaskOriginHistory and ordinary message rendering',
  notCovered: 'Submission, model picker, plugin cards, real database, live device-link and model understanding',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ dataOwnerId: null }); export const useOptionalAuth = () => null; export const useOptionalAuthDeviceId = () => null;',
    'src/renderer/hooks/useProviders': 'export const useProviders = () => ({ providers: [], loading: false });',
    'src/renderer/features/bots/BotModelChainEditor': 'export const BotModelChainEditor = () => null;',
    'src/renderer/components/chat/GhostToolCard': 'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "fixture-card-toggle";',
  },
  cases: { default: { about: 'Create from an existing writing task' }, history: { about: 'Read captured source messages within companion history' } },
  async check(page, ui) {
    if (ui.case === 'history') {
      assert.ok(await page.getByText('The narrator uses first person.', { exact: false }).count());
      assert.ok(await page.getByRole('button', { name: await ui.t('bots.fromTask.openSource') }).isVisible());
    } else {
      assert.ok(await page.getByText(await ui.t('bots.fromTask.role'), { exact: true }).isVisible());
      assert.equal(await page.locator('input').first().inputValue(), 'Novel');
      const role = page.getByLabel(await ui.t('bots.fromTask.role'), { exact: true });
      await role.fill('Review narrative consistency');
      assert.equal(await role.inputValue(), 'Review narrative consistency');
    }
  },
};
