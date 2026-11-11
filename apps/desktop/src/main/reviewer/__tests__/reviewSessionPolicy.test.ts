import { describe, expect, it } from 'vitest';

import type { MakerSessionCreateOpts } from '../../maker-ipc/sessionRequest.js';
import { enforceReviewCreateOptions } from '../reviewSessionPolicy.js';

describe('Review session policy', () => {
  it('clears native resume and all context-widening options during rehydration', () => {
    const options = {
      id: 'review-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-5.6',
      resumeSessionId: 'native-thread-with-history',
      makerMemoryEnabled: true,
      userPrompt: 'private user prompt',
      permissionMode: 'bypassPermissions',
      planMode: true,
      orcaRole: 'lead',
    } as MakerSessionCreateOpts;

    enforceReviewCreateOptions(options);

    expect(options).toMatchObject({
      reviewMode: true,
      makerMemoryEnabled: false,
      permissionMode: 'ask',
      planMode: false,
      orcaRole: null,
    });
    expect(options.resumeSessionId).toBeUndefined();
    expect(options.userPrompt).toBeUndefined();
  });
});
