import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const modelSelectorSource = readFileSync(
  resolve(__dirname, '..', 'components', 'new-chat', 'ModelSelector.tsx'),
  'utf8',
);

describe('ModelSelector paid model navigation', () => {
  it('writes the billing deep link to the hash-router location', () => {
    const start = modelSelectorSource.indexOf('const showPaymentRequired = () => {');
    expect(start).toBeGreaterThanOrEqual(0);

    const end = modelSelectorSource.indexOf('// ── 单个模型行', start);
    expect(end).toBeGreaterThan(start);

    const paymentRequiredBlock = modelSelectorSource.slice(start, end);
    expect(paymentRequiredBlock).toContain(
      "window.location.hash = '#/settings?tab=billing';",
    );
    expect(paymentRequiredBlock).not.toContain('window.history');
  });
});
