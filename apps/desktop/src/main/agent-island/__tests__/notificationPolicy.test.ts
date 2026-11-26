import { describe, expect, it } from 'vitest';

import {
  shouldNotifyAgentIslandForSession,
} from '../notificationPolicy.js';

describe('Agent Island notification policy', () => {
  it('suppresses Orca worker sessions by default', () => {
    const config = { notifyOrcaWorkerSessions: false };

    expect(shouldNotifyAgentIslandForSession(config, true)).toBe(false);
    expect(shouldNotifyAgentIslandForSession(config, false)).toBe(true);
  });

  it('can opt Orca worker sessions back into Agent Island notifications internally', () => {
    const config = { notifyOrcaWorkerSessions: true };

    expect(shouldNotifyAgentIslandForSession(config, true)).toBe(true);
    expect(shouldNotifyAgentIslandForSession(config, false)).toBe(true);
  });
});
