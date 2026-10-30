import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { companionImportEntryRangeSchema, companionImportToolArgs } from '../importProviderSchema.js';

type JsonSchema = { type?: string; items?: unknown; prefixItems?: unknown; minItems?: number; maxItems?: number; properties?: Record<string, JsonSchema> };

/** Every `items` keyword in the published schema must be a single schema (2020-12 compatible), never a tuple array. */
function tupleItemPaths(schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'items' && Array.isArray(value)) found.push(`${path}.items`);
    found.push(...tupleItemPaths(value, `${path}.${key}`));
  }
  return found;
}

async function publishedInputSchema(args: Record<string, z.ZodType>): Promise<JsonSchema> {
  const server = new McpServer({ name: 'companion_import', version: '1.0.0' });
  server.tool('import_agent', 'test', args, async () => ({ content: [] }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools[0]!.inputSchema as JsonSchema;
  } finally { await client.close(); await server.close(); }
}

describe('companion_import tool schema (#5317)', () => {
  it('publishes entryRanges without draft-07 tuple items, as xAI validates tool schemas against 2020-12', async () => {
    const schema = await publishedInputSchema(companionImportToolArgs);
    expect(tupleItemPaths(schema)).toEqual([]);
    const ranges = schema.properties!.selection!.properties!.entryRanges!;
    expect(ranges.type).toBe('array');
    const range = ranges.items as JsonSchema;
    expect(range).toMatchObject({ type: 'array', minItems: 2, maxItems: 2 });
    expect(range.items).toMatchObject({ type: 'integer', minimum: 0 });
    expect(range.prefixItems).toBeUndefined();
  });

  it('counter-evidence: the former z.tuple definition is what produced the rejected tuple items', async () => {
    const legacy = { ...companionImportToolArgs, selection: z.object({ entryRanges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).optional() }).optional() };
    const schema = await publishedInputSchema(legacy);
    expect(tupleItemPaths(schema)).toEqual(['$.properties.selection.properties.entryRanges.items.items']);
  });

  it('still only accepts [first, last] pairs of non-negative integers at the wire boundary', () => {
    expect(companionImportEntryRangeSchema.safeParse([0, 4]).success).toBe(true);
    expect(companionImportEntryRangeSchema.safeParse([3]).success).toBe(false);
    expect(companionImportEntryRangeSchema.safeParse([1, 2, 3]).success).toBe(false);
    expect(companionImportEntryRangeSchema.safeParse([-1, 2]).success).toBe(false);
    expect(companionImportEntryRangeSchema.safeParse([0.5, 2]).success).toBe(false);
  });
});
