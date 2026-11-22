/**
 * Shared Skill preparation before a Skill listing.
 *
 * Startup only warms the shared Skill preparation (built-in bundle and shared links) in the
 * background, and that pass is rejected while a saved owner is still being restored. Every
 * listing that scans installed Skills (the local SkillHub scan, the remote Skills list served
 * to a phone or another computer, and new-computer setup migration) joins the same
 * preparation first; PreparationCache lets it join an in-flight run instead of starting
 * another. Agent launches and the palette listing await `ensureSharedGlobalSkills` directly.
 */
import { createLogger } from '../logger';

const log = createLogger('skillhub');

/** Waits for the preparation; a broken optional Skill must not hide the rest of the list. */
export async function joinSharedSkillPreparation(
  prepare: (() => Promise<void>) | undefined,
  listing: 'scan' | 'remote-scan' | 'setup-migration',
): Promise<void> {
  try {
    await prepare?.();
  } catch (error) {
    log.warn('shared Skill preparation failed before listing', {
      listing,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}
