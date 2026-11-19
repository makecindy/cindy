/**
 * Shared global Skill preparation: the built-in Skill bundle publication, the legacy built-in link
 * migration and the shared home-level Skill links, under the stable-owner projection boundary
 * (release table row 25, 25b). Moved unchanged from `DesktopClaudeAuthAdapter.ensureSharedGlobalSkills`
 * and `runEnsureSharedGlobalSkills` (auth-adapters.ts) so the Node Host runs the same code; the
 * desktop binds the Electron values, the Host binds its own. The 30-second completion cache and the
 * once-per-set persistent warnings stay per instance, as they were per adapter instance.
 */
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { assertGhostSkillProjectionBoundaryStableForOwner, withSharedGlobalSkillProjectionMutation } from '../authBoundaryQuarantine.js';
import { createLogger } from '../logger.js';
import { migrateBuiltInGlobalSkillLinks, prepareBuiltInSkills } from './built-in-skills.js';
import { PreparationCache } from './preparation-cache.js';
import {
  prepareSharedGlobalSkillLinks,
  SHARED_GLOBAL_SKILL_SYNC_DISABLED_NOTICE,
  sharedGlobalSkillLinksFingerprint,
} from './shared-global-skills.js';

/**
 * Same scope as the adapter's: these warnings carry user-chosen Skill names and absolute paths and
 * stay out of log upload (`log-upload/sourceAllowlist` DENIED_SUB_SCOPES).
 */
const assetPrepLog = createLogger('auth-adapters:asset-prep');

/**
 * The active owner, its cache key and whether it is still current. Moved unchanged from auth-adapters.ts,
 * where the Codex asset preparation uses it too; the Node Host binds it as the preparation scope.
 */
export function preparationScope(): { key: string; ownerId: string | null; current: () => boolean } {
  const owner = getActiveAppSession();
  return {
    key: JSON.stringify([owner.dataOwnerId, owner.generation, isAppSessionBoundaryPending()]),
    ownerId: owner.dataOwnerId,
    current: () => {
      const latest = getActiveAppSession();
      return !isAppSessionBoundaryPending() && latest.generation === owner.generation
        && latest.dataOwnerId === owner.dataOwnerId;
    },
  };
}

export interface SharedGlobalSkillsPreparationPorts {
  /** The active owner, its cache key and whether it is still current (auth-adapters `preparationScope`). */
  preparationScope(): { key: string; ownerId: string | null; current(): boolean };
  /** The built-in Skill bundle this build carries. */
  bundledSystemSkillsRoot(): string;
  userDataDir(): string;
  appDataDir(): string;
}

export function createSharedGlobalSkillsPreparation(ports: SharedGlobalSkillsPreparationPorts): {
  ensureSharedGlobalSkills(): Promise<void>;
} {
  const sharedSkillsPreparation = new PreparationCache(30_000);
  /** Last reported set of persistent projection warnings; each set is logged once. */
  let reportedPersistentSkillWarnings = '[]';

  async function ensureSharedGlobalSkills(): Promise<void> {
    const scope = ports.preparationScope();
    // The opt-in setting and root listings are part of the key so a cached completion
    // never hides a crossAgentSyncEnabled toggle or an added/removed global skill.
    const key = JSON.stringify([scope.key, await sharedGlobalSkillLinksFingerprint()]);
    await sharedSkillsPreparation.ensure(key, async () => {
      const success = await runEnsureSharedGlobalSkills(scope.ownerId);
      return success && scope.current();
    });
  }

  async function runEnsureSharedGlobalSkills(ownerId: string | null): Promise<boolean> {
    try {
      const result = await withSharedGlobalSkillProjectionMutation(ownerId, async () => {
        // Bundle publication keeps every managed Agent link on one stable
        // active pointer. The stable-owner boundary prevents a passive profile
        // from participating in that transaction.
        const preparedBuiltIns = await prepareBuiltInSkills({
          bundledRoot: ports.bundledSystemSkillsRoot(),
          userDataDir: ports.userDataDir(),
          appDataDir: ports.appDataDir(),
        });
        const migrationWarnings = preparedBuiltIns.projectionSafe
          ? await migrateBuiltInGlobalSkillLinks({ userDataDir: ports.userDataDir(), appDataDir: ports.appDataDir() })
          : [];
        const sharedProjection = await prepareSharedGlobalSkillLinks({
          assertOwnerStable: () => assertGhostSkillProjectionBoundaryStableForOwner(ownerId),
        });
        const persistent = new Set(sharedProjection.persistentWarnings);
        return {
          warnings: [
            ...preparedBuiltIns.warnings,
            ...migrationWarnings,
            ...sharedProjection.warnings.filter((warning) => !persistent.has(warning)),
          ],
          persistentWarnings: sharedProjection.persistentWarnings,
        };
      });
      for (const warning of result.warnings) {
        assetPrepLog.warn('shared global skill warning', { warning });
      }
      // The sync opt-out and user-owned conflicting paths are stable state, not failures:
      // report each distinct set once and let the completion cache hold past them.
      const persistentSignature = JSON.stringify([...result.persistentWarnings].sort());
      if (persistentSignature !== reportedPersistentSkillWarnings) {
        reportedPersistentSkillWarnings = persistentSignature;
        for (const warning of result.persistentWarnings) {
          if (warning === SHARED_GLOBAL_SKILL_SYNC_DISABLED_NOTICE) {
            assetPrepLog.info('shared global skill notice', { warning });
          } else {
            assetPrepLog.warn('shared global skill warning', { warning });
          }
        }
      }
      return result.warnings.length === 0;
    } catch (error) {
      assetPrepLog.warn('prepare shared global skills failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  return { ensureSharedGlobalSkills };
}
