import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerMigratedInteractionSettler,
  settleMigratedInteractionsForSessionExternal,
} from '../migratedInteractionSettleRegistry';

describe('migratedInteractionSettleRegistry', () => {
  const unregister: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of unregister.splice(0)) dispose();
  });

  it('settles every channel that still owns migrated interactions for one session', () => {
    const first = vi.fn();
    const second = vi.fn();
    unregister.push(
      registerMigratedInteractionSettler('shared-session', first),
      registerMigratedInteractionSettler('shared-session', second),
    );

    settleMigratedInteractionsForSessionExternal('shared-session', 'session_aborted');

    expect(first).toHaveBeenCalledWith('session_aborted');
    expect(second).toHaveBeenCalledWith('session_aborted');
  });

  it('keeps later channel ownership when an earlier channel unregisters', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerMigratedInteractionSettler('handoff-session', first);
    unregister.push(registerMigratedInteractionSettler('handoff-session', second));
    unregisterFirst();

    settleMigratedInteractionsForSessionExternal('handoff-session', 'session_cleanup');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('session_cleanup');
  });
});
