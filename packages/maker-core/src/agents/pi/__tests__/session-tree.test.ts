import { describe, expect, it } from 'vitest';

import {
  activePiHistoryFromTree,
  normalizePiSessionTree,
  piContextTokensFromTree,
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
