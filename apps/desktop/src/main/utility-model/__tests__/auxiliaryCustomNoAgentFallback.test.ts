import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');

describe('custom auxiliary chain does not hit the session agent', () => {
  it('Help keeps the session oneShot fallback behind isAuxiliaryModelCustomized', () => {
    const source = readFileSync(path.join(root, 'maker-ipc/help.ts'), 'utf8');
    expect(
      source.match(/const auxiliaryModelCustomized = isAuxiliaryModelCustomized\(\);/g)?.length,
    ).toBe(2);
    expect(source).toContain('!auxiliaryModelCustomized');
    expect(source.match(/maker\.oneShot/g)?.length).toBeGreaterThan(0);
    expect(source).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(source.match(/beforeDispatch: async \(\) => isHelpOwnerScopeCurrent\(ownerScopeKey\)/g)?.length).toBe(2);
  });

  it('pinned-card summaries skip agent oneShot when the auxiliary list is customized', () => {
    const source = readFileSync(path.join(root, 'sessionTaskSummary.ts'), 'utf8');
    expect(source).toContain('const auxiliaryModelCustomized = isAuxiliaryModelCustomized();');
    expect(source).toContain('auxiliaryModelCustomized ||');
    expect(source).toContain('await getMaker().oneShot');
    expect(source).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(source).toContain('beforeDispatch: async () => isAuxiliaryOwnerScopeCurrent(ownerScopeKey)');
  });
});
