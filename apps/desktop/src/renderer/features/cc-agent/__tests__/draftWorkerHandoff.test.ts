import { describe, expect, it } from 'vitest';

import { buildDraftWorkerInitialTask } from '../draftWorkerHandoff';

describe('buildDraftWorkerInitialTask', () => {
  it('includes pending Lead input for a controlled device that cannot query it yet', () => {
    expect(buildDraftWorkerInitialTask(' Review the current work ', ' Implement sidebar filters '))
      .toBe(`Review the current work

Pending Lead input:
The Lead has not sent this input yet, so it is not available in Lead session history. Use it only as context for the Worker task above; do not treat it as a replacement task.
Implement sidebar filters`);
  });

  it('keeps a self-contained Worker task unchanged when there is no pending Lead input', () => {
    expect(buildDraftWorkerInitialTask(' Review PR #42 ', '   ')).toBe('Review PR #42');
  });

  it('does not turn the pending Lead input into a Worker task', () => {
    expect(buildDraftWorkerInitialTask('   ', 'Implement sidebar filters')).toBeUndefined();
  });
});
