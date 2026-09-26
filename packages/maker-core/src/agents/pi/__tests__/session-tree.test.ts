import { describe, expect, it } from 'vitest';

import {
  activePiHistoryFromTree,
  normalizePiSessionTree,
  piContextTokensFromTree,
  piRetryBranch,
  userDraftTextFromPiEntry,
} from '../session-tree.js';

const treeData = {
  leafId: 'tool-result',
  tree: [
    {
      entry: {
        type: 'message', id: 'root-user', parentId: null, timestamp: '2026-07-31T01:00:00.000Z',
        message: { role: 'user', content: 'Fix the bug' },
      },
      label: 'start',
      children: [
        {
          entry: {
            type: 'message', id: 'assistant-a', parentId: 'root-user', timestamp: '2026-07-31T01:00:01.000Z',
            message: {
              role: 'assistant', model: 'gpt-test', stopReason: 'toolUse',
              usage: { input: 23, output: 7, cacheRead: 41, cacheWrite: 5 },
              content: [
                { type: 'thinking', thinking: 'Inspect first' },
                { type: 'text', text: 'I will inspect it.' },
                { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
              ],
            },
          },
          children: [
            {
              entry: {
                type: 'message', id: 'tool-result', parentId: 'assistant-a', timestamp: '2026-07-31T01:00:02.000Z',
                message: {
                  role: 'toolResult', toolCallId: 'call-1', toolName: 'read',
                  content: [{ type: 'text', text: 'file body' }],
                },
              },
              children: [],
            },
            {
              entry: {
                type: 'message', id: 'abandoned-user', parentId: 'assistant-a', timestamp: '2026-07-31T01:00:03.000Z',
                message: { role: 'user', content: 'Try another way' },
              },
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

describe('pi session tree adapter', () => {
  function retryTree(tail: Array<Record<string, unknown>>) {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'retry me' } },
      ...tail,
    ];
    const nodes = entries.map((entry, i) => ({
      entry: { ...entry, id: String(i), parentId: i ? String(i - 1) : null },
      children: [] as unknown[],
    }));
    nodes.forEach((node, i) => { if (i) nodes[i - 1].children.push(node); });
    return { tree: [nodes[0]], leafId: String(nodes.length - 1) };
  }
  const emptyFailure = {
    type: 'message', message: {
      role: 'assistant', stopReason: 'error', content: [], errorMessage: '413 length limit exceeded',
    },
  };
  const settings = [
    { type: 'model_change', provider: 'local', modelId: 'replacement' },
    { type: 'thinking_level_change', thinkingLevel: 'high' },
  ];

  it('allows model and effort changes around an empty failure without mutating history', () => {
    const tree = retryTree([...settings, emptyFailure, ...settings]);
    const before = structuredClone(tree);
    expect(piRetryBranch(tree, '0')).toEqual({ parentId: null, requestTooLarge: true });
    expect(tree).toEqual(before);
  });

  it('does not mistake settings alone for a failed response', () => {
    expect(() => piRetryBranch(retryTree(settings), '0')).toThrow('no failed response');
  });

  it.each([
    { type: 'message', message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'partial' }] } },
    { type: 'message', message: { role: 'assistant', stopReason: 'error', content: [{ type: 'toolCall', name: 'bash' }] } },
    { type: 'message', message: { role: 'toolResult', content: [] } },
    { type: 'custom', customType: 'plan-state' },
    { type: 'compaction', summary: 'progress' },
  ])('still protects output and other session state after settings changes: %j', entry => {
    expect(() => piRetryBranch(retryTree([emptyFailure, ...settings, entry]), '0'))
      .toThrow('discard output or session state');
  });

  it('restores gateway calls using the same tool contract as live events', () => {
    const data = structuredClone(treeData);
    const block = data.tree[0].children[0].entry.message.content[2];
    Object.assign(block, { name: 'cindy_mcp_call_tool', arguments: {
      server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'demo', tool: 'show' },
    } });
    const history = activePiHistoryFromTree(data, normalizePiSessionTree(data));
    expect(history.find(m => m.role === 'tool_use')?.content).toEqual({
      toolUseId: 'call-1', toolName: 'mcp:cindy:ghost_call', input: { ghost_id: 'demo', tool: 'show' },
    });
  });
  it('normalizes branches and derives the active root-to-leaf path', () => {
    const snapshot = normalizePiSessionTree(treeData);
    expect(snapshot.leafId).toBe('tool-result');
    expect(snapshot.activePathIds).toEqual(['root-user', 'assistant-a', 'tool-result']);
    expect(snapshot.roots[0]).toMatchObject({
      id: 'root-user', role: 'user', preview: 'Fix the bug', label: 'start',
    });
    expect(snapshot.roots[0].children[0].children).toHaveLength(2);
  });

  it('rebuilds only the active path with deterministic ids and ordered blocks', () => {
    const snapshot = normalizePiSessionTree(treeData);
    const history = activePiHistoryFromTree(treeData, snapshot);
    expect(history.map((message) => message.role)).toEqual([
      'user', 'thinking', 'assistant', 'tool_use', 'tool_result',
    ]);
    expect(history.map((message) => message.clientId)).toEqual([
      'pi-tree-root-user-user',
      'pi-tree-assistant-a-thinking-0',
      'pi-tree-assistant-a-text-1',
      'pi-tree-assistant-a-tool-2',
      'pi-tree-tool-result-result',
    ]);
    expect(history[3]).toMatchObject({ toolUseId: 'call-1' });
    expect(history[4].content).toBe('file body');
    expect(history.every((message, index) => index === 0 || message.createdAt > history[index - 1].createdAt)).toBe(true);
  });

  it('extracts a selected user prompt for composer restoration', () => {
    expect(userDraftTextFromPiEntry(treeData.tree[0].entry)).toBe('Fix the bug');
    expect(userDraftTextFromPiEntry(treeData.tree[0].children[0].entry)).toBeUndefined();
  });

  it('restores context usage from the last active assistant call', () => {
    expect(piContextTokensFromTree(treeData)).toBe(69);
  });

  it('drops malformed nodes rather than exposing arbitrary raw entry data', () => {
    expect(normalizePiSessionTree({ tree: [{ entry: { type: 'message' }, children: [] }] })).toEqual({
      roots: [], leafId: null, activePathIds: [],
    });
  });
});
