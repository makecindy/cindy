import { describe, expect, it } from 'vitest';

import { redirectSystemPath } from '../../app/+native-intent';

describe('mobile native deep-link redirects', () => {
  it('routes the Share Extension handoff into a new conversation', () => {
    expect(redirectSystemPath({
      path: 'cindycn://expo-sharing',
      initial: true,
    })).toBe('/sessions/new');
    expect(redirectSystemPath({
      path: '/expo-sharing?source=share-extension',
      initial: false,
    })).toBe('/sessions/new');
  });

  it('preserves existing auth and ordinary deep-link behavior', () => {
    expect(redirectSystemPath({
      path: 'cindy://auth?code=abc',
      initial: true,
    })).toBe('/');
    expect(redirectSystemPath({
      path: '/sessions/session-1',
      initial: false,
    })).toBe('/sessions/session-1');
  });
});
