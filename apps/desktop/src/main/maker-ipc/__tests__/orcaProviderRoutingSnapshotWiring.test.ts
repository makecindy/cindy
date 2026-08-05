import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

describe('Orca provider routing snapshot wiring', () => {
  it('derives provider views and registry identities from one selectable catalog snapshot', () => {
    const start = registerSource.indexOf('getProviderRoutingContext: async () => {');
    const end = registerSource.indexOf('readClaudeApiKey,', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const wiring = registerSource.slice(start, end);

    expect(wiring).toContain('const catalog = getDesktopSelectableCatalog();');
    expect(wiring).toContain('catalog,');
    expect(wiring).toContain('const modelRegistry = catalog.modelRegistry;');
    expect(wiring).not.toContain('getActiveCatalog().modelRegistry');
  });
});
