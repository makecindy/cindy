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

  it('keeps the payment explanation action enabled for assistive technology', () => {
    const start = modelSelectorSource.indexOf('const renderModelItem =');
    const end = modelSelectorSource.indexOf('const emptyState =', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const modelRowBlock = modelSelectorSource.slice(start, end);
    expect(modelRowBlock).toContain('aria-disabled={disabled ? true : undefined}');
    expect(modelRowBlock).toContain(
      "`${model.displayName} · ${t('newChat.modelSelector.paymentRequired.unlock')}`",
    );
    expect(modelRowBlock).not.toContain('aria-disabled={disabled || paymentRequired}');
  });
});
