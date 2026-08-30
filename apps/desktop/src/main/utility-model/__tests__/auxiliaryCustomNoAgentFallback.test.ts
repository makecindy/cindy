import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');

describe('custom auxiliary chain does not hit the session agent', () => {
  it('Help keeps the session oneShot fallback behind isAuxiliaryModelCustomized', () => {
    const source = readFileSync(path.join(root, 'maker-ipc/help.ts'), 'utf8');
    expect(source).toContain('!isAuxiliaryModelCustomized()');
    expect(source.match(/maker\.oneShot/g)?.length).toBeGreaterThan(0);
  });

  it('pinned-card summaries skip agent oneShot when the auxiliary list is customized', () => {
    const source = readFileSync(path.join(root, 'sessionTaskSummary.ts'), 'utf8');
    expect(source).toContain('isAuxiliaryModelCustomized()');
    expect(source).toMatch(/isAuxiliaryModelCustomized\(\)[\s\S]{0,180}\.oneShot/);
  });
});
