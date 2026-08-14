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
  it('fails closed by default and lists every authorized path', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      kind: 'external-path' as const,
      label: `contract-${index + 1}.pdf`,
      path: `/outside/contract-${index + 1}.pdf`,
    }));
    const options = buildReviewArtifactConfirmationDialog(items, (key) => translations[key] ?? key);

    expect(options.buttons).toEqual(['Cancel', 'Allow']);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    expect(options.detail).toContain('/outside/contract-1.pdf');
    expect(options.detail).toContain('/outside/contract-11.pdf');
    expect(options.detail).toContain('/outside/contract-20.pdf');
    expect(options.detail).not.toContain('and 10 more');
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

    expect(options.detail).toContain('safe.pdf Hidden');
    expect(options.detail).toContain('/outside/safe.pdf spoofed');
  });
});
