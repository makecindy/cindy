import { describe, expect, it } from 'vitest';

import { buildReviewArtifactConfirmationDialog } from '../reviewArtifactDialog.js';

const translations: Record<string, string> = {
  'review.externalArtifactConfirm.title': 'Confirm',
  'review.externalArtifactConfirm.message': 'Send {{count}} items',
  'review.externalArtifactConfirm.detail': 'Review these paths',
  'review.externalArtifactConfirm.inline': 'inline',
  'review.externalArtifactConfirm.allow': 'Allow',
  'review.externalArtifactConfirm.cancel': 'Cancel',
};

describe('review external-artifact dialog', () => {
  it('provides explicit cancel copy and lists every authorized path', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      kind: 'external-path' as const,
      label: `contract-${index + 1}.pdf`,
      path: `/outside/contract-${index + 1}.pdf`,
    }));
    const options = buildReviewArtifactConfirmationDialog(items, (key) => translations[key] ?? key);

    expect(options.cancelText).toBe('Cancel');
    expect(options.allowText).toBe('Allow');
    expect(options.items).toHaveLength(20);
    expect(options.items[0]).toMatchObject({ path: '/outside/contract-1.pdf' });
    expect(options.items[10]).toMatchObject({ path: '/outside/contract-11.pdf' });
    expect(options.items[19]).toMatchObject({ path: '/outside/contract-20.pdf' });
  });

  it('flattens control and bidi characters in labels and paths', () => {
    const options = buildReviewArtifactConfirmationDialog(
      [
        {
          kind: 'external-path',
          label: 'safe.pdf\nHidden\u202e',
          path: '/outside/safe.pdf\u2028spoofed',
        },
      ],
      (key) => translations[key] ?? key,
    );

    expect(options.items[0]).toMatchObject({
      label: 'safe.pdf Hidden',
      path: '/outside/safe.pdf spoofed',
    });
  });
});
