import { describe, expect, it } from 'vitest';
import { reviewAction } from '../shared/auto-review.js';
import { cursorReviewAction } from './permissions.js';

describe('Cursor native approval evidence', () => {
  const workingDir = '/synthetic/project';
  it('does not execute or approve a display title as command evidence', () => {
    const action = cursorReviewAction({ kind: 'execute', title: 'pwd', rawInput: {} }, workingDir);
    expect(action).toMatchObject({ kind: 'exec', command: '' });
    expect(reviewAction(action, [workingDir])).not.toBe('auto-approve');
  });
  it('retains a reported unknown execution directory instead of claiming workspace authority', () => {
    const action = cursorReviewAction({ kind: 'execute', rawInput: { command: 'rm -rf cache', cwd: '' } }, workingDir);
    expect(action).toMatchObject({ cwdUnknown: true });
    expect(reviewAction(action, [workingDir])).not.toBe('auto-approve');
  });
  it('does not silently approve an edit without canonical write evidence', () => {
    const action = cursorReviewAction({ kind: 'edit', locations: [{ path: `${workingDir}/alias/output.txt` }] }, workingDir);
    expect(reviewAction(action, [workingDir])).not.toBe('auto-approve');
  });
  it('does not treat a multi-location read as only its first safe target', () => {
    const action = cursorReviewAction({ kind: 'read', rawInput: { path: `${workingDir}/README.md` },
      locations: [{ path: `${workingDir}/README.md` }, { path: '/synthetic/.aws/credentials' }] }, workingDir);
    expect(reviewAction(action, [workingDir])).not.toBe('auto-approve');
  });
  it('keeps an opaque MCP operation in the shared reviewer instead of classifying its title as a read', () => {
    const action = cursorReviewAction({ kind: 'other', title: 'Read fixture', rawInput: { method: 'send', destination: 'fixture' } }, workingDir);
    expect(reviewAction(action, [workingDir])).not.toBe('auto-approve');
  });
});
