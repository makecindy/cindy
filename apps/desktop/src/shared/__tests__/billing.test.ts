import { describe, expect, it } from 'vitest';

import { isAllowedBillingMailto, isAllowedBillingMailtoRequest } from '../billing.js';

describe('billing mailto policy', () => {
  it('allows localized subject and body for the fixed support inbox', () => {
    expect(
      isAllowedBillingMailto(
        'mailto:xd-billing@xd.com?subject=Invoice%20request&body=Order%20details',
      ),
    ).toBe(true);
  });

  it.each(['to=other@example.com', 'cc=other@example.com', 'bcc=other@example.com'])(
    'rejects recipient-affecting %s headers',
    (header) => {
      expect(isAllowedBillingMailto(`mailto:xd-billing@xd.com?subject=x&${header}`)).toBe(false);
    },
  );

  it('rejects duplicate prefill fields', () => {
    expect(isAllowedBillingMailto('mailto:xd-billing@xd.com?subject=first&subject=second')).toBe(
      false,
    );
  });

  it('rejects alternate recipients and malformed mailto URLs', () => {
    expect(isAllowedBillingMailto('mailto:other@example.com?subject=x')).toBe(false);
    expect(isAllowedBillingMailto('mailto://xd-billing@xd.com?subject=x')).toBe(false);
    expect(isAllowedBillingMailto('mailto:xd-billing%40xd.com%FF?subject=x')).toBe(false);
  });

  it('requires a trusted sender in addition to the URL policy', () => {
    expect(isAllowedBillingMailtoRequest('mailto:xd-billing@xd.com?subject=x', false)).toBe(false);
    expect(isAllowedBillingMailtoRequest('mailto:xd-billing@xd.com?subject=x', true)).toBe(true);
  });
});
