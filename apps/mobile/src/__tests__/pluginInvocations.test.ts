import { describe, expect, it } from 'vitest';
import { projectLargeSettledToolInputs } from '@/session/messageToolPayloadProjection';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import type { RemoteMessage } from '@/session/types';
const msg = (id: string, role: RemoteMessage['role'], content: unknown, extra: Partial<RemoteMessage> = {}): RemoteMessage => ({
  id, clientId: id, sessionId: 's', role, content, toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00Z', ...extra,
});
const call = (id: string, name = 'mcp__cindy__ghost_call', input: unknown = { ghost_id: 'art', tool: 'generate' }) =>
  msg(id, 'tool_use', { toolName: name, toolUseId: id, input }, { toolUseId: id });
describe('plugin annotations on user messages', () => {
  it('retains call identity when large arguments are released after completion', () => {
    const source = [msg('u', 'user', 'Draw'), call('c', undefined, { ghost_id: 'art', tool: 'generate', args: { data: 'x'.repeat(40_000) } }), msg('r', 'tool_result', 'done', { toolUseId: 'c' })];
    const projected = projectLargeSettledToolInputs(source);
    expect(normalizeRemoteMessages(projected)[0].pluginInvocations).toEqual([{ id: 'art', name: 'art', tools: ['generate'], hasPendingCalls: false }]);
    expect(JSON.stringify(projected)).not.toContain('x'.repeat(40_000));
  });
  it('uses actual calls and discovery names, deduplicates tools, and rebuilds from history', () => {
    const rows = [msg('user', 'user', 'Draw a cat'), call('info', 'mcp__cindy__ghost_info', { ghost_id: 'art' }),
      msg('result', 'tool_result', JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: true, ghost: { id: 'art', name: 'Art' } }) }] }), { toolUseId: 'info' }),
      call('c1'), call('c2')];
    for (let i = 0; i < 2; i++) expect(normalizeRemoteMessages(rows)[0].pluginInvocations).toEqual([{ id: 'art', name: 'Art', tools: ['generate'], hasPendingCalls: true }]);
  });
  it('settles plugins independently while other calls and assistant output continue', () => {
    const rows = [msg('u', 'user', 'Work'), call('a'),
      call('b', undefined, { ghost_id: 'browser', tool: 'read' }),
      // This result is adjacent to b, but belongs only to a.
      msg('ra', 'tool_result', '', { toolUseId: 'a' }),
      msg('text', 'assistant', 'Still working')];
    const plugins = () => normalizeRemoteMessages(rows)[0].pluginInvocations;
    expect(plugins()).toMatchObject([
      { id: 'art', hasPendingCalls: false }, { id: 'browser', hasPendingCalls: true },
    ]);
    rows.push(call('a2'));
    expect(plugins()?.[0].hasPendingCalls).toBe(true);
    rows.push(msg('rb', 'tool_result', '{"ok":false}', { toolUseId: 'b' }),
      msg('ra2', 'tool_result', 'done', { toolUseId: 'a2' }));
    expect(plugins()?.map((plugin) => plugin.hasPendingCalls)).toEqual([false, false]);
  });
  it('keeps steers in their owner turn and never carries calls into the next question', () => {
    const rows = normalizeRemoteMessages([msg('u1', 'user', 'art'), msg('steer', 'user', 'blue', { agentMeta: { delivery: 'steer' } }), call('c'), msg('u2', 'user', 'art')]);
    expect(rows[0].pluginInvocations).toHaveLength(1);
    expect(rows[1].pluginInvocations).toBeUndefined();
    expect(rows[3].pluginInvocations).toBeUndefined();
  });
  it('ignores mentions, discovery-only, unrelated tools and attachment preauthorization', () => {
    const rows = normalizeRemoteMessages([msg('u', 'user', 'Use Art'), call('i', 'mcp__cindy__ghost_info'), call('other', 'not_ghost_call'), call('grant', undefined, { ghost_id: 'art', grant_only: true })]);
    expect(rows[0].pluginInvocations).toBeUndefined();
  });
  it('does not credit child-agent calls or hidden synthetic turns to a visible user', () => {
    const rows = normalizeRemoteMessages([msg('u', 'user', 'Hello'), call('child', undefined, { ghost_id: 'child' }), msg('hidden', 'user', '[UI_ACTION_TRIGGER] continue'), call('c')].map((m) => m.id === 'child' ? { ...m, agentMeta: { parentUuid: 'parent' } } : m));
    expect(rows[0].pluginInvocations).toBeUndefined();
  });
  it('falls back to an ID when old host discovery was truncated', () => {
    const rows = normalizeRemoteMessages([msg('u', 'user', 'hello'), call('info', 'mcp__cindy__ghost_info', { ghost_id: 'art' }), msg('r', 'tool_result', '{"ok":true,', { toolUseId: 'info' }), call('c')]);
    expect(rows[0].pluginInvocations?.[0].name).toBe('art');
  });
});
