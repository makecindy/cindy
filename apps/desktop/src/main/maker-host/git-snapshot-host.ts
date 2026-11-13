/**
 * Host adapter for automatic Git snapshots.
 *
 * This file wires the pure GitSnapshotCoordinator to desktop main-process
 * dependencies: maker session metadata, repo detection, local message lookup,
 * and oneShot label generation.
 *
 * The body lives in gitSnapshotHostCore.ts, shared with the Node Host; this module
 * binds the desktop route guard and keeps the export Desktop callers use.
 */

import type { GitSnapshotCoordinator } from '../git-snapshot/gitSnapshotCoordinator.js';
import {
  createGitSnapshotCoordinatorWithRouteGuard,
  type GitSnapshotCoordinatorHostDeps,
  type MakerForGitSnapshot,
} from './gitSnapshotHostCore.js';
import { isAgentOneShotRouteDisabled } from './model-route-guard-live.js';

export type { GitSnapshotCoordinatorHostDeps };

/**
 * Constructs the automatic snapshot coordinator from real desktop host deps.
 */
export function createGitSnapshotCoordinator(
  maker: MakerForGitSnapshot,
  deps: GitSnapshotCoordinatorHostDeps = {},
): GitSnapshotCoordinator {
  return createGitSnapshotCoordinatorWithRouteGuard(maker, { isAgentOneShotRouteDisabled }, deps);
}
