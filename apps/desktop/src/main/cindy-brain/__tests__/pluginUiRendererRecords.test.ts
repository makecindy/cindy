import { describe, expect, it, vi } from 'vitest';
import { createPluginUiRendererRecords } from '../pluginUiRendererRecords.js';

/* A renderer must bind to the stored message/tool identity, never a nearby
 * result or an ambiguous same-name plugin. Existing message rendering tests
 * do not cover data released to another plugin. Tier: production projection
 * with injected storage and identity lookup. */
describe('plugin renderer record projection', () => {
  it('uses the saved plugin source and refuses ambiguous or missing identities', async () => {
    const readMessage = vi.fn(async () => ({ role: 'user', content: JSON.stringify('hello'), agentMeta: JSON.stringify({ sourcePlugin: { pluginId: 'writer' } }) }));
    const resolvePlugin = vi.fn(() => undefined as string | undefined);
    const records = createPluginUiRendererRecords({ readMessage, readTool: async () => null, resolvePlugin });
    const scope = { kind: 'message' as const, sessionId: 'task', messageClientId: 'message' };
    expect(await records.read(scope)).toBeNull();
    resolvePlugin.mockReturnValue('writer-instance');
    expect(await records.read(scope)).toMatchObject({ source: { kind: 'plugin', instanceId: 'writer-instance' },
      message: { id: 'message', role: 'user', text: 'hello' } });
    expect(readMessage).toHaveBeenCalledWith('task', 'message');
  });
  it('pairs only an exact tool id and does not expose private metadata or replace a legacy card', async () => {
    const call = { role: 'tool_use', toolUseId: 'call', content: JSON.stringify({ toolName: 'mcp:cindy:ghost_call',
      input: { ghost_id: 'writer', namespace: 'team', tool: 'format', args: { text: 'input' } } }) };
    const resolvePlugin = vi.fn(() => '_ns__team__writer');
    let results = [{ role: 'tool_result', toolUseId: 'other', content: JSON.stringify('wrong') }];
    const records = createPluginUiRendererRecords({ readMessage: async () => null,
      readTool: async () => ({ calls: [call], results }), resolvePlugin });
    const scope = { kind: 'tool' as const, sessionId: 'task', toolUseId: 'call' };
    expect(await records.read(scope)).toMatchObject({ source: { kind: 'plugin', instanceId: '_ns__team__writer', name: 'format' },
      tool: { id: 'call', status: 'unknown' } });
    expect((await records.read(scope))?.tool).not.toHaveProperty('result');
    results = [{ role: 'tool_result', toolUseId: 'call', content: JSON.stringify({ _meta: { private: 'secret' }, content: 'visible' }) }];
    expect((await records.read(scope))?.tool).not.toHaveProperty('result');
    results = [{ role: 'tool_result', toolUseId: 'call', content: JSON.stringify(JSON.stringify({ _meta: { private: 'secret' } })) }];
    expect((await records.read(scope))?.tool).not.toHaveProperty('result');
    results = [{ role: 'tool_result', toolUseId: 'call', content: JSON.stringify({ xdt_card_id: 'card', result: 'done' }) }];
    expect(await records.read(scope)).toMatchObject({ legacy: true });
    expect(resolvePlugin).toHaveBeenCalledWith('writer', 'team');
  });
  it('does not project ambiguous duplicate calls or guess a plugin for an incomplete ghost call', async () => {
    const call = { role: 'tool_use', toolUseId: 'call', content: JSON.stringify({ toolName: 'mcp:cindy:ghost_call', input: { ghost_id: 'writer', tool: 'format' } }) };
    let calls = [call, call];
    const records = createPluginUiRendererRecords({ readMessage: async () => null,
      readTool: async () => ({ calls, results: [] }), resolvePlugin: () => undefined });
    const scope = { kind: 'tool' as const, sessionId: 'task', toolUseId: 'call' };
    expect(await records.read(scope)).toBeNull();
    calls = [call];
    expect(await records.read(scope)).toBeNull();
  });
});
