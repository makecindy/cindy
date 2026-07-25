/**
 * Diffs setup-relevant plugin lifecycle state before waking coordinators.
 *
 * GhostManager and builtin reconciliation both publish full snapshots. This
 * tracker turns those broad broadcasts into one revision-only change event
 * per plugin whose manifest, enabled state, or session availability changed.
 */

import type { InstalledGhost } from '../../shared/ghost.js';
import type { GhostSetupChangeBus } from './ghostSetupChangeBus.js';

export class GhostSetupManifestTracker {
  private fingerprints = new Map<string, string>();

  constructor(
    private readonly changeBus: GhostSetupChangeBus,
    private readonly isAvailable: (ghostId: string) => boolean,
  ) {}

  seed(ghosts: InstalledGhost[]): void {
    this.fingerprints = this.snapshot(ghosts);
  }

  note(ghosts: InstalledGhost[]): string[] {
    const next = this.snapshot(ghosts);
    const changed = new Set([...this.fingerprints.keys(), ...next.keys()]);
    const changedIds = [...changed]
      .filter((ghostId) => this.fingerprints.get(ghostId) !== next.get(ghostId))
      .sort();

    // Commit the new baseline before notifying. A listener may synchronously
    // re-read or trigger another roster broadcast; it must not re-emit the
    // same lifecycle transition.
    this.fingerprints = next;
    for (const ghostId of changedIds) {
      this.changeBus.emit(ghostId, { source: 'manifest' });
    }
    return changedIds;
  }

  private snapshot(ghosts: InstalledGhost[]): Map<string, string> {
    return new Map(
      ghosts.map((ghost) => [
        ghost.manifest.id,
        JSON.stringify({
          enabled: ghost.enabled,
          available: this.isAvailable(ghost.manifest.id),
          manifest: ghost.manifest,
        }),
      ]),
    );
  }
}
