import { describe, expect, it } from 'vitest';
import { projectHarnessContent } from '../harnessContent.js';

describe('Harness public content projection', () => {
  it('keeps only public text blocks and marks omitted non-text content', () => {
    expect(
      projectHarnessContent('assistant', [
        { type: 'text', text: 'answer' },
        { type: 'thinking', text: 'private' },
      ]),
    ).toEqual({ content: [{ type: 'text', text: 'answer' }], truncated: true });
  });
  it('does not export tool native identity or metadata alongside approved arguments', () => {
    expect(
      projectHarnessContent('tool_use', {
        toolName: 'write',
        input: { path: 'file' },
        toolUseId: 'native',
        agentMeta: { signature: 'private' },
      }),
    ).toEqual({ content: { toolName: 'write', input: { path: 'file' } } });
  });
  it('bounds large tool results and marks truncation', () => {
    const result = projectHarnessContent('tool_result', 'x'.repeat(50_000));
    expect(result.truncated).toBe(true);
    expect((result.content as string).length).toBe(16_384);
  });
});
