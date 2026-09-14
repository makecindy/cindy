import { describe, expect, it } from 'vitest';
import { isPublicationProcessingFailure } from '../scanResultPresentation';

describe('scan result presentation', () => {
  it('distinguishes a server processing error from a security rejection', () => {
    expect(isPublicationProcessingFailure([{ name: 'INTERNAL_ERROR' }])).toBe(true);
    expect(isPublicationProcessingFailure([{ name: 'security-scan' }])).toBe(false);
    expect(isPublicationProcessingFailure(undefined)).toBe(false);
  });
});
