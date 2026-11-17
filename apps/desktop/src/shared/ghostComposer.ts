import { z } from 'zod';
import type { InstalledGhost } from './ghost';
import { installedGhostStoragePart } from './pluginIdentity';

export const GHOST_COMPOSER_LIST_CHANNEL = 'ghosts:composer-list';

/** Icon content tag: 32 lowercase hex characters (a SHA-256 prefix computed by the host). */
export const COMPOSER_ICON_REF_RE = /^[0-9a-f]{32}$/;
/** Upper bound for the icon tags a controller may report in one catalog read. */
export const MAX_COMPOSER_KNOWN_ICONS = 512;

/** Only public command metadata crosses devices; never installation paths or credentials. */
const ghostComposerEntrySchema = z.object({
  manifest: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    command: z.string().min(1).max(32).regex(/^\S+$/u).optional(),
    tools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
  }),
  enabled: z.boolean(),
  /** Absent on old peers. null is an explicit root instance. */
  namespace: z.string().min(1).nullable().optional(),
  /**
   * Physical instance key. Absent on old peers; never a filesystem path.
   * In-place migrated installs keep their original key, which can differ from manifest.id.
   */
  instanceKey: z.string().min(1).max(167).optional(),
  hasSkill: z.boolean().optional(),
  iconDataUrl: z.string().optional(),
  /**
   * Content tag of the icon, only for controllers that asked for icon references.
   * The icon itself is omitted when the controller reported it already holds this tag.
   */
  iconRef: z.string().regex(COMPOSER_ICON_REF_RE).optional(),
});

/** Optional second argument of the remote catalog read; old hosts ignore it. */
export interface GhostComposerListOptions {
  /** Ask for `iconRef` tags so icons the controller already holds can be omitted. */
  iconRefs: 1;
  /** Icon tags the controller already holds for this host. */
  knownIcons?: string[];
}

export const ghostComposerListSchema = z.array(ghostComposerEntrySchema);
export type GhostComposerEntry = z.infer<typeof ghostComposerEntrySchema>;

/** Shared structural input for command placement, decoration and send-time expansion. */
export type GhostCommandSource = Pick<GhostComposerEntry, 'manifest' | 'enabled' | 'iconDataUrl' | 'namespace' | 'instanceKey'>;

export function projectGhostComposerEntries(
  ghosts: readonly InstalledGhost[],
  disabledIds: readonly string[] = [],
): GhostComposerEntry[] {
  const disabled = new Set(disabledIds);
  return ghosts
    .filter(
      (ghost) =>
        !ghost.retirement &&
        (ghost.manifest.id !== 'cindy-mivo' ||
          !ghosts.some((item) => item.manifest.id === 'xd-mivo')),
    )
    .map((ghost) => {
      const { manifest, enabled, iconDataUrl, namespace } = ghost;
      // Directory disablement is stored by storage part, not the bare manifest id.
      const instanceKey = installedGhostStoragePart(ghost);
      return {
        manifest: {
          id: manifest.id,
          name: manifest.name,
          ...(manifest.command ? { command: manifest.command } : {}),
          ...(manifest.tools
            ? {
                tools: manifest.tools.map(({ name, description, parameters }) => ({
                  name,
                  description,
                  ...(parameters ? { parameters } : {}),
                })),
              }
            : {}),
        },
        enabled: enabled && !disabled.has(instanceKey),
        instanceKey,
        hasSkill: !!manifest.skill,
        ...(namespace !== undefined ? { namespace } : {}),
        ...(iconDataUrl ? { iconDataUrl } : {}),
      };
    });
}
