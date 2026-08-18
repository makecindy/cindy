import { describe, expect, it } from 'vitest';

import { TAB_IDS } from '@/lib/tabLabels';

describe('Settings tab order', () => {
  it('places billing immediately after model providers', () => {
    const providersIndex = TAB_IDS.indexOf('providers');

    expect(TAB_IDS.slice(providersIndex, providersIndex + 2)).toEqual(['providers', 'billing']);
  });

  it('places Plugins immediately before builtin tools', () => {
    const toolsIndex = TAB_IDS.indexOf('builtin-tools');

    expect(TAB_IDS.slice(toolsIndex - 1, toolsIndex + 1)).toEqual(['ghosts', 'builtin-tools']);
  });
});
