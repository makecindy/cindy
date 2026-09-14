import { describe, expect, it } from 'vitest';

import { skillPublisherLabel } from '../publisherLabel';

describe('skillPublisherLabel', () => {
  it('shows both the member publisher and organization owner', () => {
    expect(skillPublisherLabel({
      publisherName: 'Cindy Publisher',
      authorName: 'Acme',
    })).toBe('Cindy Publisher · Acme');
  });

  it('does not duplicate a personal owner fallback', () => {
    expect(skillPublisherLabel({
      publisherName: 'Cindy Publisher',
      authorName: 'Cindy Publisher',
    })).toBe('Cindy Publisher');
  });
});
