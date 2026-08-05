import { describe, expect, it } from 'vitest';
import { parseMobilePiSessionTree } from '@/session/piSessionTreeModel';

describe('Pi session tree projection', () => {
  it('accepts the device-link tree shape and discards malformed nodes at every depth', () => {
    expect(parseMobilePiSessionTree({
      roots: [{
        id: 'root', role: 'user', preview: 'Start here', label: 'Question',
        children: [
          { id: 'child', role: 'assistant', preview: 'Answer', children: [] },
          { id: 42, preview: 'invalid node' },
        ],
      }],
      leafId: 'child',
      activePathIds: ['root', 'child', 99],
    })).toEqual({
      roots: [{
        id: 'root', role: 'user', preview: 'Start here', label: 'Question',
        children: [{ id: 'child', role: 'assistant', preview: 'Answer', children: [] }],
      }],
      leafId: 'child',
      activePathIds: ['root', 'child'],
    });
  });

  it('fails closed for non-tree device-link payloads instead of rendering or navigating arbitrary data', () => {
    expect(parseMobilePiSessionTree(null)).toBeNull();
    expect(parseMobilePiSessionTree({ roots: 'not-an-array' })).toBeNull();
  });

  it('rejects trees that exceed the device-link recursion budget', () => {
    let node: Record<string, unknown> = { id: 'leaf', preview: 'leaf', children: [] };
    for (let depth = 0; depth < 70; depth += 1) {
      node = { id: `node-${depth}`, preview: '', children: [node] };
    }
    expect(parseMobilePiSessionTree({ roots: [node] })).toBeNull();

    expect(parseMobilePiSessionTree({
      roots: Array.from({ length: 2_001 }, (_, index) => ({
        id: `root-${index}`,
        preview: '',
        children: [],
      })),
    })).toBeNull();
  });
});
