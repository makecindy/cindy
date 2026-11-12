import { describe, expect, it } from 'vitest';
import { parseGhostContextBlocks, parseGhostMemoryEntries, parseGhostSystemPromptFragments } from '../runtimeContext.js';

// Protocol, unit: these parsers receive untrusted plugin replies. Unlike model
// routing tests, they must bound inline material and discard forged origins.
describe('runtime provider replies', () => {
  it('requires static task-scoped prompt fragments with unique identities and explicit order', () => {
    const fragment = { id: 'style', text: '{{literal}}', order: 10, scope: 'selected-task', agentKinds: ['pi'] };
    expect(parseGhostSystemPromptFragments([fragment])).toEqual([fragment]);
    for (const value of [[{ ...fragment, scope: 'all-tasks' }], [{ ...fragment, text: () => 'dynamic' }],
      [{ ...fragment, order: 0.5 }], [fragment, fragment]]) expect(parseGhostSystemPromptFragments(value)).toBeUndefined();
  });
  it('keeps literal provider material and strips self-reported origin', () => {
    expect(parseGhostContextBlocks([{ id: 'b', text: '{{literal}}', sourcePlugin: 'other' }])).toEqual([{ id: 'b', text: '{{literal}}' }]);
    expect(parseGhostMemoryEntries([{ id: 'm', title: 'Title', content: 'Body', sourcePlugin: 'other' }])).toEqual([{ id: 'm', title: 'Title', content: 'Body' }]);
  });
  it('rejects duplicate context identities and oversized reference material', () => {
    expect(parseGhostContextBlocks([{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }])).toBeUndefined();
    expect(parseGhostContextBlocks([{ id: 'large', text: 'x'.repeat(32769) }])).toBeUndefined();
  });
  it('rejects unsupported memory categories, duplicate ids and unbounded content', () => {
    const item = { id: 'm', title: 'Title', content: 'Body' };
    expect(parseGhostMemoryEntries([{ ...item, type: 'secret' }])).toBeUndefined();
    expect(parseGhostMemoryEntries([item, item])).toBeUndefined();
    expect(parseGhostMemoryEntries([{ ...item, content: 'x'.repeat(32769) }])).toBeUndefined();
  });
});
