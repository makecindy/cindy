import { describe, expect, it } from 'vitest';
import { DEFAULT_HEADLESS_TIMEOUT_MS, resolveHeadlessTimeout } from './defaults.js';

describe('Headless CLI defaults', () => {
  it('uses an 1800-second standalone deadline', () => {
    expect(DEFAULT_HEADLESS_TIMEOUT_MS).toBe(1_800_000);
    expect(resolveHeadlessTimeout(undefined, undefined)).toEqual({
      owner: 'headless',
      timeoutMs: 1_800_000,
    });
  });

  it('allows an external owner to disable Headless timing explicitly', () => {
    expect(resolveHeadlessTimeout('external', undefined)).toEqual({
      owner: 'external',
      timeoutMs: null,
    });
    expect(() => resolveHeadlessTimeout('external', '1000')).toThrow(
      '--timeout-ms cannot be used with --timeout-owner external',
    );
  });

  it('validates owner and explicit Headless deadlines', () => {
    expect(resolveHeadlessTimeout('headless', '2500')).toEqual({
      owner: 'headless',
      timeoutMs: 2500,
    });
    expect(() => resolveHeadlessTimeout('invalid', undefined)).toThrow(
      '--timeout-owner must be headless or external',
    );
    expect(() => resolveHeadlessTimeout('headless', '0')).toThrow(
      '--timeout-ms must be a positive number',
    );
  });
});
