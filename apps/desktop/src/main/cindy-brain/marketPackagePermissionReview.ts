/**
 * Bridges a marketplace metadata/package permission mismatch without weakening
 * the install boundary.
 *
 * The marketplace detail manifest is what Renderer displayed. The downloaded
 * package manifest is what would actually run. When the package contains
 * permissions that were not displayed, updates may continue only if those
 * permissions are already present in the installed plugin; otherwise Renderer
 * must explicitly review the real package manifest first.
 */

import { diffGhostPermissionItems, type GhostManifest } from '../../shared/ghost.js';

export class MarketPackagePermissionReviewRequiredError extends Error {
  readonly manifest: GhostManifest;
  readonly unreviewedPermissionKeys: string[];

  constructor(manifest: GhostManifest, unreviewedPermissionKeys: string[]) {
    super('Downloaded Plugin package permissions require review');
    this.name = 'MarketPackagePermissionReviewRequiredError';
    this.manifest = manifest;
    this.unreviewedPermissionKeys = unreviewedPermissionKeys;
  }
}

export function assertMarketPackagePermissionsReviewed(input: {
  reviewedManifest: GhostManifest;
  packageManifest: GhostManifest;
  installedManifest: GhostManifest | null;
}): void {
  const unreviewed = diffGhostPermissionItems(input.reviewedManifest, input.packageManifest).added;
  if (unreviewed.length === 0) return;

  // A metadata projection may omit permissions that the installed version
  // already has. That mismatch is worth logging, but it is not an expansion
  // and therefore needs no additional user approval.
  if (
    input.installedManifest &&
    diffGhostPermissionItems(input.installedManifest, input.packageManifest).added.length === 0
  ) {
    return;
  }

  throw new MarketPackagePermissionReviewRequiredError(
    input.packageManifest,
    unreviewed.map((item) => item.key),
  );
}

export function isMarketPackagePermissionReviewRequiredError(
  error: unknown,
): error is MarketPackagePermissionReviewRequiredError {
  return error instanceof MarketPackagePermissionReviewRequiredError;
}
