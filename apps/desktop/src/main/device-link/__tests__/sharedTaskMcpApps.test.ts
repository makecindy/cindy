import { describe, expect, it } from 'vitest';
import { parseMcpAppRecord } from '@cindy/maker-shared/mcp-apps';
import { redactMessageRowForSharedGuest } from '../sharedTaskMessageOrigin';

describe('shared guest MCP App history projection', () => {
  const card = {
    version: 1,
    serverId: 'private-server',
    serverRevision: 'private-revision',
    resourceUri: 'ui://private/app',
    tool: { name: 'draft', inputSchema: { type: 'object' } },
    arguments: { private: 'input' },
  };

  // R3: a shared guest needs the display name, never organization or endpoint identity.
  it('redacts private organization and connection fields while preserving public card names', () => {
    const project = (meta: unknown) => redactMessageRowForSharedGuest({ agentMeta: { mcpApp: true },
      content: { mcpApp: { ...card, tool: { ...card.tool, _meta: meta } } } }).content;
    const org = project({ 'cindy/plugin': { name: 'Planner', source: { kind: 'organization', namespace: 'acme' } } });
    expect(org).toEqual({ mcpAppHistory: { version: 1, title: 'Planner', text: '', plugin: { name: 'Planner', source: { kind: 'organization' } } } });
    const custom = project({ 'cindy/custom-mcp': { name: 'Team reports', url: 'https://private.invalid:8443', serverId: 'private-slug' } });
    expect(custom).toEqual({ mcpAppHistory: { version: 1, title: 'Team reports · Custom MCP', text: '', customMcp: { name: 'Team reports' } } });
  });

  it.each([false, true])(
    'retains a pending card name without private inputs (serialized=%s)',
    (serialized) => {
      const original = { mcpApp: card };
      const row = {
        content: serialized ? JSON.stringify(original) : original,
        agentMeta: { mcpApp: true },
      };
      const projected = redactMessageRowForSharedGuest(row);
      expect(projected.content).toEqual({
        mcpAppHistory: { version: 1, customMcp: true, title: 'draft', text: '' },
      });
      expect(parseMcpAppRecord(projected.content)).toBeUndefined();
      expect(row.content).toEqual(serialized ? JSON.stringify(original) : original);
    },
  );

  it.each([
    { mcpApp: { ...card, version: 2, private: 'future' } },
    { mcpApp: { ...card, result: { content: 'private-invalid' } } },
    { mcpApp: null, private: 'envelope' },
    '{private-invalid-json',
  ])('does not leak malformed or unsupported card records: %j', (content) => {
    expect(
      redactMessageRowForSharedGuest({ content, agentMeta: { mcpApp: true } }).content,
    ).toEqual({ mcpAppHistory: { version: 1, title: '', text: '' } });
  });

  it('reprojects cached public cards using a whitelist without retaining additive data', () => {
    const row = {
      content: {
        mcpAppHistory: { version: 1, title: 'Draft', text: 'Saved', private: 'summary' },
        private: 'envelope',
      },
      agentMeta: { mcpApp: true },
    };
    const projected = redactMessageRowForSharedGuest(row);
    expect(projected.content).toEqual({
      mcpAppHistory: { version: 1, title: 'Draft', text: 'Saved' },
    });
    expect(redactMessageRowForSharedGuest(projected)).toEqual(projected);
  });

  it('preserves ordinary messages and source rows', () => {
    const row = { role: 'assistant', content: 'Ordinary result', agentMeta: {} };
    expect(redactMessageRowForSharedGuest(row)).toBe(row);
  });
  it.each([
    { mcpApp: null, text: 'Ordinary result' },
    { mcpAppHistory: { version: 1, title: 'User data', text: 'Saved', extra: 'preserve me' } },
  ])('keeps unmarked App-shaped ordinary results intact for guests: %j', (content) => {
    const row = { role: 'assistant', content, agentMeta: { mcpApp: false } };
    expect(redactMessageRowForSharedGuest(row)).toBe(row);
  });
});
