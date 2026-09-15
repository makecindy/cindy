import { describe, expect, it } from 'vitest';

import { grokBuildToolToReviewableAction, pickPermissionOptionId } from '../auto-review-policy.js';

describe('grok-build auto-review policy', () => {
  it('maps ACP tool kinds onto ReviewableAction', () => {
    expect(grokBuildToolToReviewableAction({
      toolCallId: '1', kind: 'execute', rawInput: { command: 'ls' },
    })).toEqual({ kind: 'exec', command: 'ls', cwd: undefined, cwdUnknown: false });
    expect(grokBuildToolToReviewableAction({
      toolCallId: '2', kind: 'edit', locations: [{ path: '/repo/a.ts' }],
    })).toEqual({ kind: 'file-write', path: '/repo/a.ts' });
    expect(grokBuildToolToReviewableAction({
      toolCallId: '3', kind: 'read', rawInput: { path: '/repo/a.ts' },
    })).toMatchObject({ kind: 'read', path: '/repo/a.ts' });
    expect(grokBuildToolToReviewableAction({
      toolCallId: '4', kind: 'fetch', rawInput: { url: 'https://example.com' },
    })).toMatchObject({ kind: 'network', target: 'https://example.com' });
    expect(grokBuildToolToReviewableAction({
      toolCallId: '5', kind: 'think',
    })).toEqual({ kind: 'session-state' });
    expect(grokBuildToolToReviewableAction({
      toolCallId: '6', kind: 'other', title: 'mcp',
    })).toMatchObject({ kind: 'other', description: 'mcp' });
  });

  it('picks ACP permission option ids for allow/deny', () => {
    const options = [
      { optionId: 'a1', kind: 'allow_once' },
      { optionId: 'a2', kind: 'allow_always' },
      { optionId: 'r1', kind: 'reject_once' },
    ];
    expect(pickPermissionOptionId(options, 'allow')).toBe('a1');
    expect(pickPermissionOptionId(options, 'allow', true)).toBe('a2');
    expect(pickPermissionOptionId(options, 'deny')).toBe('r1');
  });

  it('fail-closes deny when only allow_* options exist', () => {
    const options = [{ optionId: 'a1', kind: 'allow_once' }];
    expect(pickPermissionOptionId(options, 'deny')).toBeNull();
  });
});
