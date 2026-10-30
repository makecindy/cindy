import { z } from 'zod';

/**
 * Argument schema of the `companion_import.import_agent` MCP tool.
 *
 * Kept free of host dependencies so the exact JSON Schema handed to model
 * providers can be asserted in tests. Upstream providers (xAI Grok among them)
 * validate tool definitions against JSON Schema 2020-12, where tuple-style
 * `items: [...]` arrays are rejected outright; the MCP SDK emits that form for
 * `z.tuple` because it targets draft-07. `entryRanges` therefore uses a plain
 * fixed-length integer array (#5317). `validateImportSelection` still enforces
 * ordering, non-overlap and `[first, last]` pairing on the business side.
 */
const sourceIndex = z.number().int().nonnegative();
export const companionImportEntryRangeSchema = z.array(sourceIndex).length(2);

export const companionImportToolArgs = {
  operation: z.enum(['sources', 'preview', 'start', 'status']), sourceId: z.string().optional(),
  selection: z.object({ previewId: z.string(), requestId: z.string(), name: z.string(), avatarImageBase64: z.string().min(1).max(2_000_000).optional(), entryIds: z.array(z.string()), takeover: z.boolean(), deferSetup: z.boolean().default(true), entryRanges: z.array(companionImportEntryRangeSchema).optional() }).optional(),
  requestId: z.string().optional(),
};
