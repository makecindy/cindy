import { z } from 'zod';
import type { InstalledGhost } from './ghost';

export const GHOST_COMPOSER_LIST_CHANNEL = 'ghosts:composer-list';

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
  hasSkill: z.boolean().optional(),
  iconDataUrl: z.string().optional(),
});

export const ghostComposerListSchema = z.array(ghostComposerEntrySchema);
export type GhostComposerEntry = z.infer<typeof ghostComposerEntrySchema>;

/** Shared structural input for command placement, decoration and send-time expansion. */
export type GhostCommandSource = Pick<GhostComposerEntry, 'manifest' | 'enabled' | 'iconDataUrl'>;

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
    .map(({ manifest, enabled, iconDataUrl }) => ({
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
      enabled: enabled && !disabled.has(manifest.id),
      hasSkill: !!manifest.skill,
      ...(iconDataUrl ? { iconDataUrl } : {}),
    }));
}
