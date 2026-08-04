import { describe, expect, it } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost.js';
import {
  assertMarketPackagePermissionsReviewed,
  MarketPackagePermissionReviewRequiredError,
} from '../marketPackagePermissionReview.js';

function manifest(toolNames: string[]): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '2.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: toolNames.length > 0 ? ['tool'] : [],
    ...(toolNames.length > 0
      ? {
          tools: toolNames.map((name) => ({
            name,
            description: `${name} description`,
          })),
        }
      : {}),
  };
}

describe('assertMarketPackagePermissionsReviewed', () => {
  it('throws an error carrying the real package manifest when metadata omitted a new permission', () => {
    const packageManifest = manifest(['existing_tool', 'new_tool']);

    expect(() =>
      assertMarketPackagePermissionsReviewed({
        reviewedManifest: manifest([]),
        packageManifest,
        installedManifest: manifest(['existing_tool']),
      }),
    ).toThrow(MarketPackagePermissionReviewRequiredError);

    try {
      assertMarketPackagePermissionsReviewed({
        reviewedManifest: manifest([]),
        packageManifest,
        installedManifest: manifest(['existing_tool']),
      });
    } catch (error) {
      expect(error).toMatchObject({
        manifest: packageManifest,
        unreviewedPermissionKeys: ['tool:existing_tool', 'tool:new_tool'],
      });
    }
  });

  it('allows an update when the omitted package permissions were already installed', () => {
    expect(() =>
      assertMarketPackagePermissionsReviewed({
        reviewedManifest: manifest([]),
        packageManifest: manifest(['existing_tool']),
        installedManifest: manifest(['existing_tool']),
      }),
    ).not.toThrow();
  });

  it('requires the real package manifest to be reviewed for a first install', () => {
    expect(() =>
      assertMarketPackagePermissionsReviewed({
        reviewedManifest: manifest([]),
        packageManifest: manifest(['new_tool']),
        installedManifest: null,
      }),
    ).toThrow(MarketPackagePermissionReviewRequiredError);
  });
});
