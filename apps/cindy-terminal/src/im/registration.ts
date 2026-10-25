export type ChannelRegistrationState = {
  status: 'pending' | 'success' | 'expired' | 'cancelled' | 'error';
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: number;
  verdict?: 'connected' | 'pending' | 'conflict' | 'error';
};

/** The transport keeps the device code and credentials. Only the controller
 * holding the protected configuration lease can read the authorization URL. */
export class TerminalFeishuRegistration {
  private active?: { id: string; state: ChannelRegistrationState; current(): void; timer?: NodeJS.Timeout };
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly invoke: (channel: string, value?: unknown) => Promise<unknown>) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => {});
    return result;
  }
  begin(id: string, service: unknown, current: () => void, deadline: number): Promise<ChannelRegistrationState> {
    if (service !== 'feishu' && service !== 'lark') return Promise.reject(new Error('INVALID_CONFIGURATION'));
    return this.serial(async () => {
      current(); if (this.closed) throw new Error('REGISTRATION_CLOSED');
      if (this.active?.id === id) return this.read(id);
      if (this.active?.state.status === 'pending') throw new Error('REGISTRATION_BUSY');
      const entry = { id, current, state: { status: 'pending' } as ChannelRegistrationState, timer: undefined as NodeJS.Timeout | undefined };
      this.active = entry;
      try {
        const result = await this.invoke('feishuBot:registration-begin', { service }) as Record<string, unknown>;
        current(); if (this.closed || this.active !== entry) throw new Error('REGISTRATION_CLOSED');
        if (result.ok !== true || typeof result.verificationUrl !== 'string' || typeof result.userCode !== 'string'
          || typeof result.expiresIn !== 'number' || !Number.isFinite(result.expiresIn) || result.expiresIn <= 0) throw new Error('REGISTRATION_FAILED');
        const url = new URL(result.verificationUrl);
        if (url.protocol !== 'https:' || url.username || url.password || !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname)) throw new Error('REGISTRATION_FAILED');
        // Match the protected lease lifetime. Never extend an expired exchange.
        const expiresAt = Math.min(deadline, Date.now() + result.expiresIn * 1000);
        if (entry.state.status === 'pending') {
          entry.state = { status: 'pending', verificationUrl: url.href, userCode: result.userCode, expiresAt };
          entry.timer = setTimeout(() => { void this.cancel(id, 'expired').catch(() => {}); }, expiresAt - Date.now());
          entry.timer.unref();
        }
        return { ...entry.state };
      } catch {
        if (entry.timer) clearTimeout(entry.timer);
        entry.state = { status: 'error' };
        await this.invoke('feishuBot:registration-cancel').catch(() => {});
        throw new Error('REGISTRATION_FAILED');
      }
    });
  }
  read(id: string): ChannelRegistrationState {
    const entry = this.active;
    if (this.closed || !entry || entry.id !== id) throw new Error('REGISTRATION_STALE');
    entry.current();
    return { ...entry.state };
  }
  receive(raw: unknown) {
    const entry = this.active;
    if (!entry || entry.state.status !== 'pending' || !raw || typeof raw !== 'object') return;
    try { entry.current(); } catch { void this.cancel(entry.id).catch(() => {}); return; }
    const value = raw as Record<string, unknown>;
    if (!['success', 'expired', 'cancelled', 'error'].includes(String(value.status))) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.state = { status: value.status as ChannelRegistrationState['status'],
      ...(value.status === 'success' && ['connected', 'pending', 'conflict', 'error'].includes(String(value.verdict)) ? { verdict: value.verdict as ChannelRegistrationState['verdict'] } : {}) };
  }
  cancel(id: string, status: 'cancelled' | 'expired' = 'cancelled'): Promise<void> {
    return this.serial(async () => {
      const entry = this.active;
      if (!entry || entry.id !== id) return;
      const pending = entry.state.status === 'pending';
      if (entry.timer) clearTimeout(entry.timer);
      if (pending) {
        entry.state = { status };
        await this.invoke('feishuBot:registration-cancel');
      }
    });
  }
  async close() {
    this.closed = true;
    if (this.active) await this.cancel(this.active.id).catch(() => {});
    await this.tail;
    this.active = undefined;
  }
}
