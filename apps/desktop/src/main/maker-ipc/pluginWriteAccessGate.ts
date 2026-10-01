type Mode = 'acceptEdits' | 'auto';
/** Process-local refusal memory. Reloading a plugin does not renew an automatic attempt. */
export class PluginWriteAccessGate {
  private readonly attempts = new Map<string, { identity: string; mode: Mode; pending: boolean }>();

  recoverable(key: string, identity: string): Mode | null {
    const state = this.attempts.get(key);
    return state?.identity === identity && !state.pending ? state.mode : null;
  }

  async request<T extends { granted: boolean }>(key: string, identity: string, mode: Mode, explicit: boolean, attempt: () => Promise<T>): Promise<T | { granted: false }> {
    const previous = this.attempts.get(key);
    if (previous?.pending || (!explicit && previous?.identity === identity)) return { granted: false };
    const state = { identity, mode, pending: true };
    this.attempts.set(key, state);
    try {
      const result = await attempt();
      if (result.granted && this.attempts.get(key) === state) this.attempts.delete(key);
      return result;
    } finally {
      state.pending = false;
    }
  }
}
