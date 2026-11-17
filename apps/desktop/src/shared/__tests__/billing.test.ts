import { describe, expect, it } from 'vitest';

import { isAllowedBillingMailto, isAllowedBillingMailtoRequest } from '../billing.js';

describe.each(['xd-billing@xd.com', 'feedback@cindy.app'])('billing mailto policy for %s', (recipient) => {
  it('allows localized subject and body for the fixed support inbox', () => {
    expect(
      isAllowedBillingMailto(
        `mailto:${recipient}?subject=Billing%20request&body=Order%20details`,
      ),
    ).toBe(true);
  });

  it.each(['to=other@example.com', 'cc=other@example.com', 'bcc=other@example.com'])(
    'rejects recipient-affecting %s headers',
    (header) => {
      expect(isAllowedBillingMailto(`mailto:${recipient}?subject=x&${header}`)).toBe(false);
    },
  );

  it('rejects duplicate prefill fields', () => {
    expect(isAllowedBillingMailto(`mailto:${recipient}?subject=first&subject=second`)).toBe(
      false,
    );
  });

  it('rejects fragments that could be interpreted differently by native mail handlers', () => {
    expect(
      isAllowedBillingMailto(`mailto:${recipient}?subject=x#&bcc=attacker@example.com`),
    ).toBe(false);
  });

  it.each(['%0D%0ABcc%3Aattacker%40example.com', '%09Bcc%3Aattacker%40example.com'])
    ('rejects control characters in the subject', (subject) => {
      expect(
        isAllowedBillingMailto(`mailto:${recipient}?subject=${subject}&body=details`),
      ).toBe(false);
    });

  it('rejects alternate recipients and malformed mailto URLs', () => {
    expect(isAllowedBillingMailto('mailto:other@example.com?subject=x')).toBe(false);
    expect(isAllowedBillingMailto(`mailto://${recipient}?subject=x`)).toBe(false);
    expect(isAllowedBillingMailto(`mailto:${encodeURIComponent(recipient)}%FF?subject=x`)).toBe(false);
  });

  it('requires a trusted sender in addition to the URL policy', () => {
    expect(isAllowedBillingMailtoRequest(`mailto:${recipient}?subject=x`, false)).toBe(false);
    expect(isAllowedBillingMailtoRequest(`mailto:${recipient}?subject=x`, true)).toBe(true);
  });
});
