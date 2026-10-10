import { z } from 'zod';

/** Matches the existing Desktop ghosts:composer-list public projection. */
export const composerPluginListSchema = z.array(z.object({
  manifest: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    command: z.string().min(1).max(32).regex(/^\S+$/u).optional(),
    tools: z.array(z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    })).optional(),
  }),
  enabled: z.boolean(),
  iconDataUrl: z.string().optional(),
}));
export type ComposerPlugin = z.infer<typeof composerPluginListSchema>[number];

export function isComposerPluginCatalogUnsupportedError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && code !== 'IPC_ERROR') {
    return code === 'CHANNEL_NOT_ALLOWED' || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED';
  }
  const message = (error instanceof Error ? error.message : typeof error === 'string' ? error : '')
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
    .trim();
  return /^(?:\[)?(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED(?:\])?(?:\s|$)/.test(message);
}
