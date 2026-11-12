import { afterEach, describe, expect, it } from 'vitest';
import { clearSecretPages, hasSecretPages, isSecretPage, markSecretEntered } from '../secretTaint.js';

afterEach(() => clearSecretPages());

describe('secret pages', () => {
  it('covers the same page until the tab leaves it or the hold expires', () => {
    markSecretEntered('https://login.example.com/signin?next=%2F#form', 0);
    expect(hasSecretPages(0)).toBe(true);
    expect(isSecretPage('https://login.example.com/signin', 1000)).toBe(true);
    expect(isSecretPage('https://login.example.com/home', 1000)).toBe(false);
    expect(isSecretPage('https://login.example.com/signin', 16 * 60_000)).toBe(false);
    expect(hasSecretPages(16 * 60_000)).toBe(false);
  });

  it('ignores pages it cannot place', () => {
    markSecretEntered(undefined);
    markSecretEntered('file:///tmp/x.html');
    expect(hasSecretPages()).toBe(false);
    expect(isSecretPage('')).toBe(false);
  });
});
