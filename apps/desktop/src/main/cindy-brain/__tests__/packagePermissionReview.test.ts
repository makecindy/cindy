import { describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import {
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
});
