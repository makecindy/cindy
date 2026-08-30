import { describe, expect, it } from 'vitest';

import { __testing } from '../browser-backend-settings-store.js';

describe('browser-backend-settings-store normalize', () => {
  it('defaults useRealProfile to false', () => {
    expect(__testing.normalize(undefined)).toEqual({
      kind: 'external',
      useRealProfile: false,
    });
    expect(__testing.normalize({ kind: 'rsb-webview' })).toEqual({
      kind: 'rsb-webview',
      useRealProfile: false,
    });
  });

  it('only accepts an explicit true for useRealProfile', () => {
    expect(__testing.normalize({ useRealProfile: true })).toEqual({
      kind: 'external',
      useRealProfile: true,
    });
    expect(__testing.normalize({ useRealProfile: 'true' })).toEqual({
      kind: 'external',
      useRealProfile: false,
    });
  });
});
