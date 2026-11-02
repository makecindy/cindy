import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
export default {
  name: 'skillhub-home',
  entry: './skillhub-home-fixture.tsx',
  viewport: { width: 1280, height: 800 },
  real: 'SkillhubHomeContent, PluginManagementLayout, category and sort controls, cards, navigation, translations and themes',
  notCovered:
    'Live catalog data, install/update/import, remote devices and full application sidebar behavior; catalog/auth hooks use synthetic inputs',
  stubs: {
    'src/renderer/contexts/AuthContext':
      'export const useAuth = () => ({ user: null, dataOwnerId: "fixture" }); export const useOptionalAuthDeviceId = () => null; export const useOptionalAuthUser = () => null; export const AuthProvider = ({children}) => children;',
    'src/renderer/features/skillhub/RemoteSkillsPage':
      'export const RemoteSkillsPage = () => null;',
    'src/renderer/features/skillhub/components/InstallTargetPicker':
      'export const InstallTargetPicker = () => null;',
    'src/renderer/features/skillhub/hooks/useSkillhub': {
      partial:
        'const state = { skills: [], projects: [], bootstrapped: true, syncResults: new Map() }; export const useSkillhub = () => state;',
    },
    'src/renderer/features/skillhub/hooks/useMarketSkillUpdate': {
      partial:
        'export const useMarketSkillUpdate = () => ({ updatingNames: new Set(), update: () => {} });',
    },
    'src/renderer/features/skillhub/hooks/useMarketList': {
      partial: readFileSync(new URL('./market-stub.ts', import.meta.url), 'utf8'),
    },
  },
  cases: {
    default: { about: 'PR 6102 navigation with the SkillHub card redesign' },
    narrow: {
      about: 'Narrow content keeps navigation and category controls visible',
      viewport: { width: 800, height: 800 },
    },
  },
  async ready(page) {
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.getByTestId('skill-category-filter-scroller').waitFor();
  },
  async check(page, ui) {
    const scroller = page.getByTestId('skill-category-filter-scroller');
    const bar = await scroller.boundingBox();
    const selected = await scroller.locator('[aria-checked="true"]').boundingBox();
    assert.ok(selected.x >= bar.x - 1 && selected.x + selected.width <= bar.x + bar.width + 1,
      'selected category stays visible in the 6102 navigation layout');
    await page
      .getByRole('button', { name: await ui.t('skillhub.home.sortDownloads'), exact: true })
      .click();
    await page
      .getByRole('menuitemradio', { name: await ui.t('skillhub.home.sortUpdated'), exact: true })
      .click();
    await ui.capture('sort-updated');
  },
};
