import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  scheduleCodexGlobalSkillsRefresh,
  setCodexGlobalSkillsRefreshHandler,
} from '../codex-global-skills-refresh.js';

afterEach(() => {
  setCodexGlobalSkillsRefreshHandler(null);
});

describe('codex-global-skills-refresh', () => {
  it('schedules the registered refresh handler after Ghost skill reconcile', async () => {
    const handler = vi.fn(async () => undefined);
    setCodexGlobalSkillsRefreshHandler(handler);

    scheduleCodexGlobalSkillsRefresh();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  it('ignores refresh scheduling when no handler is registered', () => {
    expect(() => scheduleCodexGlobalSkillsRefresh()).not.toThrow();
  });
});
