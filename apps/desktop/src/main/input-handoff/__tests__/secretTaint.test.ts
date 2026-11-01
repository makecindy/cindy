import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSecretPages,
  hasSecretPages,
  isSecretPage,
  isSecretTab,
  markSecretAllTabs,
  markSecretEntered,
  markSecretTargets,
  markSecretWindow,
} from '../secretTaint.js';

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

  it('covers a page it could not read by the tab title the window shows, until the hold expires', () => {
    markSecretWindow('Sign in - Google Chrome', 0);
    expect(hasSecretPages(0)).toBe(true);
    expect(isSecretTab({ url: 'https://login.example.com/', title: 'Sign in' }, 1000)).toBe(true);
    expect(isSecretTab({ url: 'https://x.com/home', title: '(5) Home / X' }, 1000)).toBe(false);
    expect(isSecretTab({ url: 'https://x.com/home' }, 1000)).toBe(false);
    expect(isSecretTab({ title: 'Sign in' }, 16 * 60_000)).toBe(false);
    markSecretWindow(undefined);
    markSecretWindow('   ');
    expect(hasSecretPages(16 * 60_000)).toBe(false);
  });

  it('keeps covering a tab by its id after the page renames itself, and fails closed when the tab is unknown', () => {
    markSecretWindow('Sign in - Google Chrome', 0);
    markSecretTargets(['tab-7'], 0);
    // The page set a new title: the title no longer matches, the id still does.
    expect(isSecretTab({ title: 'Totally unrelated', targetId: 'tab-7' }, 1000)).toBe(true);
    expect(isSecretTab({ title: 'Totally unrelated', targetId: 'tab-8' }, 1000)).toBe(false);
    expect(isSecretTab({ title: 'Totally unrelated', targetId: 'tab-7' }, 16 * 60_000)).toBe(false);
    markSecretAllTabs(0);
    expect(isSecretTab({ title: 'Anything', targetId: 'tab-9' }, 1000)).toBe(true);
    expect(isSecretTab({ title: 'Anything', targetId: 'tab-9' }, 16 * 60_000)).toBe(false);
  });

  it('ignores pages it cannot place', () => {
    markSecretEntered(undefined);
    markSecretEntered('file:///tmp/x.html');
    expect(hasSecretPages()).toBe(false);
    expect(isSecretPage('')).toBe(false);
  });
});
