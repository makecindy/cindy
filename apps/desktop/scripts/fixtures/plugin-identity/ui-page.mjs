import assert from 'node:assert/strict';

export default {
  name: 'plugin-identity', entry: './fixture.tsx', viewport: { width: 900, height: 1050 },
  real: 'Production plugin cards and detail headers: five provenance identities, anonymous community and recommendation downloads.',
  notCovered: 'Host provenance verification, network statistics and install transactions; fixture data is explicitly simulated.',
  stubs: {
    'src/renderer/contexts/AuthContext': `export const useAuth = () => ({ mode: 'cloud', dataOwnerId: 'fixture', dataOwnerGeneration: 1, isAuthenticated: true, user: { id: 'fixture-user', membershipKind: 'personal' } }); export const useOptionalAuthUser = () => null; export const useOptionalAuthDeviceId = () => 'fixture'; export const useOptionalDataOwnerGeneration = () => ({ dataOwnerId: 'fixture', generation: 1 });`,
  },
  cases: {
    preview: { about: 'Chinese recommendations with package icons, alongside the same marketplace cards.' },
    default: { about: 'Five source identities and three recommendations with download counts.' },
    narrow: { about: 'Long names retain identity and download labels at 320px.', viewport: { width: 320, height: 1400 } },
    'market-detail': { about: 'Community detail explains its identity without publishing an author.' },
    'local-detail': { about: 'Installed local detail keeps a distinct source mark.' },
  },
  async check(page, ui) {
    assert.equal(await page.getByText('PRIVATE_AUTHOR', { exact: true }).count(), 0);
    if (ui.case === 'market-detail') {
      await page.getByText(await ui.t('settings.ghosts.market.publisherDescription.community'), { exact: true }).waitFor();
    } else if (ui.case === 'local-detail') {
      await page.getByText(await ui.t('settings.ghosts.market.publisherDescription.local'), { exact: true }).waitFor();
    } else {
      const recommendations = page.locator('main > section').first();
      assert.equal(await recommendations.getByText(await ui.t('settings.ghosts.market.publisherKind.official'), { exact: true }).count(), 3);
      assert.equal(await recommendations.getByRole('group').count(), 3);
    }
  },
};
