export default {
  name: 'magpie-model-sources', entry: './magpie-model-sources-fixture.tsx',
  viewport: { width: 780, height: 520 },
  real: 'UnifiedModelRow, ModelSourceDetails, discovery-to-catalog source projection, engine configuration and production theme tokens',
  notCovered: 'Full Desktop, IPC persistence, actual Magpie calls and ModelSelector icon dispatch; gateway response is fixture data',
  stubs: {
    'src/renderer/components/new-chat/ModelSelector': `import React from 'react';
      import {ProviderLogoMark} from '@/components/icons/ProviderLogoMark';
      export function ModelIconMark({providerId}) { return <ProviderLogoMark providerId={providerId} size={16}/>; }`,
  },
  cases: {
    default: { about: 'Existing aggregate source rows show distinct suppliers; same model name on two routes' },
    provider: { about: 'Existing descriptions replaced; unknown model remains single-line' },
    narrow: { about: 'Same production rows at 320px', viewport: { width: 320, height: 520 } },
    'non-magpie': { about: 'OpenAI and Cindy AI retain their original model descriptions' },
    accounts: { about: 'Non-Magpie aggregate source rows retain recognized account identities' },
  },
  async check(page, ui) {
    const rows = page.locator('[data-unified-anchor]');
    if (ui.case === 'non-magpie' || ui.case === 'accounts') {
      if (await rows.count() !== 2) throw Error('Ordinary provider rows missing');
      for (let i = 0; i < 2; i++) {
        const row = rows.nth(i);
        if (ui.case === 'accounts') {
          const source = await row.locator('[data-model-source-details]').innerText();
          if (!source.includes('account@example.test')) throw Error('Account identity missing');
        } else if (await row.locator('[title]').filter({ hasText: await ui.t('modelDescriptions.coding') }).count() !== 1) {
          throw Error('Original model description missing');
        }
      }
      await ui.capture('ordinary-provider-rows');
      const addFavorite = await ui.t('newChat.modelSelector.unified.addFavorite');
      const removeFavorite = await ui.t('newChat.modelSelector.unified.removeFavorite');
      for (let i = 0; i < 2; i++) {
        const row = rows.nth(i);
        const other = rows.nth(1 - i);
        await row.click();
        if (await row.getAttribute('data-model-selected') !== 'true' ||
          await other.getAttribute('data-model-selected') === 'true') {
          throw Error('Selection leaked between providers sharing a model ID');
        }
        await row.hover();
        await row.getByRole('button', { name: addFavorite, exact: true }).click();
        if (await row.getByRole('button', { name: removeFavorite, exact: true }).count() !== 1 ||
          await other.getByRole('button', { name: removeFavorite, exact: true }).count() !== 0) {
          throw Error('Favorite leaked between providers sharing a model ID');
        }
        if (await row.getAttribute('data-model-selected') !== 'true') throw Error('Favorite changed selection');
        await ui.capture('ordinary-provider-state-' + i);
        await row.getByRole('button', { name: removeFavorite, exact: true }).click();
        if (await rows.getByRole('button', { name: removeFavorite, exact: true }).count() !== 0) {
          throw Error('Favorite did not clear independently');
        }
      }
      return;
    }
    if (await rows.count() !== 3) throw Error('Gateway routes merged');
    await ui.capture('source-rows');
    const first = await rows.nth(0).innerText();
    const second = await rows.nth(1).innerText();
    if (!first.includes('Supplier A') || !second.includes('Supplier B')) throw Error('Supplier identity missing');
    if (ui.case === 'provider' && await rows.nth(2).locator(':scope > *').count() !== 1) throw Error('Unknown model gained a second line');
    await rows.nth(1).click();
    if (await rows.nth(1).getAttribute('data-model-selected') !== 'true') throw Error('Selection changed route');
  },
};
