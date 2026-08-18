import { describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import {
  marketPackageHostReviewDiff,
  marketPackageManualSummaryChanged,
  marketPackageNeedsHostReview,
  marketPackageOauthIdentityChanged,
} from '../packagePermissionReview';

describe('marketPackageNeedsHostReview', () => {
  it('skips Host when the user already reviewed every permission in the real package', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: false,
        addedCount: null,
        unreviewedCount: 0,
        extrasVersusReviewedCount: 0,
      }),
    ).toBe(false);
  });

  it('reviews Host when the real package adds permissions the preview missed', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: false,
        addedCount: null,
        unreviewedCount: 0,
        extrasVersusReviewedCount: 1,
      }),
    ).toBe(true);
  });

  it('reviews a first manual install when no preview confirmation was supplied', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: false,
        addedCount: null,
        unreviewedCount: 0,
        extrasVersusReviewedCount: null,
      }),
    ).toBe(true);
  });

  it('skips a same-permission manual update when no preview confirmation was supplied', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: false,
        addedCount: 0,
        unreviewedCount: 0,
        extrasVersusReviewedCount: null,
      }),
    ).toBe(false);
  });

  it('always reviews when the built-in OAuth client changed', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: true,
        addedCount: 0,
        unreviewedCount: 0,
        extrasVersusReviewedCount: 0,
      }),
    ).toBe(true);
  });

  it('reviews when only the bundled manual summary changed', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: false,
        manualSummaryChanged: true,
        addedCount: 0,
        unreviewedCount: 0,
        extrasVersusReviewedCount: 0,
      }),
    ).toBe(true);
  });
});

function oauthManifest(clientId: string): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'oauth-plugin',
    name: 'OAuth Plugin',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['network'],
    network: {
      hosts: ['api.example.com'],
      secrets: [
        {
          key: 'account',
          label: 'Account',
          source: 'oauth',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
          oauth: {
            authorizeUrl: 'https://accounts.example.com/authorize',
            tokenUrl: 'https://accounts.example.com/token',
            clientId,
          },
        },
      ],
    },
  };
}

describe('marketPackageOauthIdentityChanged', () => {
  it('detects a clientId mismatch between the reviewed catalog and the real package', () => {
    expect(
      marketPackageOauthIdentityChanged(
        oauthManifest('preview-client'),
        oauthManifest('real-client'),
        oauthManifest('real-client'),
      ),
    ).toBe(true);
  });

  it('detects a clientId mismatch between the installed baseline and the real package', () => {
    expect(
      marketPackageOauthIdentityChanged(
        oauthManifest('old-client'),
        oauthManifest('old-client'),
        oauthManifest('new-client'),
      ),
    ).toBe(true);
  });

  it('stays quiet when reviewed, installed, and real package share the same client', () => {
    expect(
      marketPackageOauthIdentityChanged(
        oauthManifest('same-client'),
        oauthManifest('same-client'),
        oauthManifest('same-client'),
      ),
    ).toBe(false);
  });

  it('reviews when the catalog omitted clientId but the real package introduces one', () => {
    expect(
      marketPackageOauthIdentityChanged(
        oauthManifest(''),
        oauthManifest('real-client'),
        oauthManifest('real-client'),
      ),
    ).toBe(true);
    expect(
      marketPackageOauthIdentityChanged(oauthManifest(''), null, oauthManifest('real-client')),
    ).toBe(true);
  });

  it('does not treat an installed empty clientId gaining a default as a migration', () => {
    expect(
      marketPackageOauthIdentityChanged(
        oauthManifest('real-client'),
        oauthManifest(''),
        oauthManifest('real-client'),
      ),
    ).toBe(false);
  });

  it('reviews when a reviewed tokenBroker slot becomes a direct clientId', () => {
    expect(
      marketPackageOauthIdentityChanged(
        oauthBrokerManifest(),
        oauthBrokerManifest(),
        oauthManifest('direct-client'),
      ),
    ).toBe(true);
    expect(
      marketPackageOauthIdentityChanged(oauthBrokerManifest(), null, oauthManifest('direct-client')),
    ).toBe(true);
  });

  it('reviews when a reviewed direct clientId becomes a tokenBroker', () => {
    expect(
      marketPackageOauthIdentityChanged(
        oauthManifest('direct-client'),
        oauthManifest('direct-client'),
        oauthBrokerManifest(),
      ),
    ).toBe(true);
  });
});

function oauthBrokerManifest(): GhostManifest {
  const manifest = oauthManifest('broker-client');
  const secret = manifest.network?.secrets?.[0];
  if (secret?.oauth) {
    secret.oauth.tokenBroker = 'cindy';
  }
  return manifest;
}

function manualManifest(items: Array<{ name: string; dir: string; description: string }>): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'manual-plugin',
    name: 'Manual Plugin',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['notify'],
    ...(items.length > 0 ? { manual: { items } } : {}),
  };
}

describe('marketPackageManualSummaryChanged', () => {
  const guide = {
    name: 'getting-started',
    dir: 'manual/getting-started',
    description: 'Start here',
  };

  it('stays quiet when reviewed and real package share the same manuals', () => {
    expect(marketPackageManualSummaryChanged(manualManifest([guide]), manualManifest([guide]))).toBe(
      false,
    );
  });

  it('detects a count change between the reviewed catalog and the real package', () => {
    expect(marketPackageManualSummaryChanged(manualManifest([]), manualManifest([guide]))).toBe(
      true,
    );
  });

  it('detects a swapped manual identity even when the count stays the same', () => {
    expect(
      marketPackageManualSummaryChanged(
        manualManifest([guide]),
        manualManifest([
          { name: 'ops', dir: 'manual/ops', description: 'Operations' },
        ]),
      ),
    ).toBe(true);
  });

  it('does not invent a reviewed baseline when the caller omitted the catalog', () => {
    expect(marketPackageManualSummaryChanged(undefined, manualManifest([guide]))).toBe(false);
  });

  it('does not treat a newline inside one description as two manuals', () => {
    expect(
      marketPackageManualSummaryChanged(
        manualManifest([
          { name: 'a', dir: 'x', description: 'd\nb\0y\0e' },
        ]),
        manualManifest([
          { name: 'a', dir: 'x', description: 'd' },
          { name: 'b', dir: 'y', description: 'e' },
        ]),
      ),
    ).toBe(true);
  });
});

const emptyDiff = {
  added: [],
  removed: [],
  unchanged: [],
  builtinOauthClientChanged: false,
};

describe('marketPackageHostReviewDiff', () => {
  it('does not synthesize an empty update diff on first install', () => {
    expect(
      marketPackageHostReviewDiff({
        permissionDiff: null,
        extrasVersusReviewedCount: 1,
        builtinOauthClientChanged: true,
        manualSummaryChanged: false,
      }),
    ).toBeNull();
  });

  it('uses the full package card when extras exist even if the installed diff is empty', () => {
    expect(
      marketPackageHostReviewDiff({
        permissionDiff: emptyDiff,
        extrasVersusReviewedCount: 2,
        builtinOauthClientChanged: false,
        manualSummaryChanged: false,
      }),
    ).toBeNull();
  });

  it('uses the full package card when only the manual summary changed', () => {
    expect(
      marketPackageHostReviewDiff({
        permissionDiff: emptyDiff,
        extrasVersusReviewedCount: 0,
        builtinOauthClientChanged: false,
        manualSummaryChanged: true,
      }),
    ).toBeNull();
  });

  it('keeps an update diff when only the OAuth identity changed', () => {
    expect(
      marketPackageHostReviewDiff({
        permissionDiff: emptyDiff,
        extrasVersusReviewedCount: 0,
        builtinOauthClientChanged: true,
        manualSummaryChanged: false,
      }),
    ).toEqual({ ...emptyDiff, builtinOauthClientChanged: true });
  });
});
