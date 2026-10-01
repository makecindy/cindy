import { describe, expect, it } from 'vitest';

import { resolveBotAllowedBuiltinPluginIds } from '../types';

describe('Bot built-in tool baseline', () => {
  const catalog = [
    { id: 'memory', available: true },
    { id: 'xdt_helper', available: true },
    { id: 'scheduler', available: true },
    { id: 'lsp', available: true },
    { id: 'docs', available: true },
    { id: 'browser', available: false },
  ];

  it('keeps memory, the Bot helper and automations by default', () => {
    expect(resolveBotAllowedBuiltinPluginIds(catalog, [])).toEqual([
      'memory',
      'xdt_helper',
      'scheduler',
    ]);
  });

  it('adds only explicit and available optional tools', () => {
    expect(resolveBotAllowedBuiltinPluginIds(catalog, ['docs', 'browser'])).toEqual([
      'memory',
      'xdt_helper',
      'scheduler',
      'docs',
    ]);
  });

  it('does not freeze a baseline helper that is unavailable on the execution target', () => {
    expect(resolveBotAllowedBuiltinPluginIds([
      { id: 'memory', available: true },
      { id: 'xdt_helper', available: false },
    ], [])).toEqual(['memory']);
  });
});
