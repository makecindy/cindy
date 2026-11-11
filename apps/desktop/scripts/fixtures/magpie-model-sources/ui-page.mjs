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
  },
  async check(page, ui) {
    const rows = page.locator('[data-unified-anchor]');
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
