import {
  parseRemoteDesktopRequest,
  isDesktopAttemptId,
  REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS,
  type RemoteDesktopRequest,
  type RemoteDesktopLease,
} from '@cindy/device-link';
import type {
  RemoteViewerReply,
  RemoteViewerTarget,
  RemoteViewerState,
} from '../../shared/remoteDesktopViewer.js';

/** Main owns the target, account generation and lease for one lightweight viewer.
 * A destroyed/hidden window cannot leave late starts or inputs alive. No closeLink.
 */
export class RemoteViewerConnection {
  target: RemoteViewerTarget | null = null;
  active = false;
  generation = 0;
  private owner = '';
  private lease: string | null = null;
  private starting = false;
  private pending = 0;
  private attempted = false;
  private mediaAttempt: string | null = null;
  private controlling = false;
  private wantsControl = false;
  private controlGeneration = 0;
  private controlPending = false;
  private clipboardPending: object | null = null;
  private lifecycle: Promise<void> | null = null;
  constructor(
    private readonly deps: {
      owner(): string;
      request(deviceId: string, request: RemoteDesktopRequest, check: () => void): Promise<unknown>;
      readClipboard(): string;
      writeClipboard(value: string): void;
    },
  ) {}
  bind(target: RemoteViewerTarget): void {
    const owner = this.deps.owner();
    const sameScope = this.owner === owner && this.target?.deviceId === target.deviceId;
    this.deactivate();
    if (!sameScope) this.lifecycle = null;
    this.owner = owner;
    this.target = target;
    this.attempted = false;
  }
  snapshot(): RemoteViewerState {
    return {
      target: this.target,
      active: this.active,
      generation: this.generation,
      resume: this.attempted,
    };
  }
  setActive(active: boolean): void {
    if (this.owner !== this.deps.owner()) {
      this.deactivate();
      this.target = null;
      return;
    }
    if (!active) {
      if (this.active) this.deactivate();
      return;
    }
    this.active = Boolean(this.target);
  }
  check(generation: number): void {
    if (
      !this.active ||
      !this.target ||
      generation !== this.generation ||
      this.owner !== this.deps.owner()
    )
      throw new Error('DESKTOP_STOPPED');
  }
  beginMedia(generation: number, attempt: unknown): void {
    this.check(generation);
    if (!this.lease || !isDesktopAttemptId(attempt)) throw new Error('DESKTOP_VIDEO_STOPPED');
    this.mediaAttempt = attempt;
  }
  checkMedia(generation: number, attempt: unknown): void {
    this.check(generation);
    if (!this.mediaAttempt || attempt !== this.mediaAttempt)
      throw new Error('DESKTOP_VIDEO_STOPPED');
  }
  /** Renderer replacement revokes authority immediately but must not bypass same-peer cleanup. */
  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    let pending: Promise<T>;
    try {
      pending = this.lifecycle ? this.lifecycle.then(operation) : operation();
    } catch (error) {
      return Promise.reject(error);
    }
    const settled = () => {
      if (this.lifecycle === tail) this.lifecycle = null;
    };
    const tail = pending.then(settled, settled);
    this.lifecycle = tail;
    return pending;
  }
  deactivate(): void {
    this.generation++;
    this.active = false;
    const lease = this.lease,
      target = this.target,
      owner = this.owner;
    this.lease = null;
    this.mediaAttempt = null;
    this.controlling = false;
    this.wantsControl = false;
    this.controlPending = false;
    this.controlGeneration++;
    this.clipboardPending = null;
    this.starting = false;
    if (lease && target && owner === this.deps.owner())
      void this.serializeLifecycle(() =>
        this.deps.request(target.deviceId, { op: 'stop', lease }, () => {
          if (owner !== this.deps.owner()) throw new Error('DESKTOP_STOPPED');
        }),
      ).catch(() => {});
  }
  async request(
    generation: number,
    value: unknown,
    mediaAttempt?: string,
  ): Promise<RemoteViewerReply> {
    try {
      this.check(generation);
      const request = parseRemoteDesktopRequest(value);
      const check = () =>
        request.op === 'offer' || request.op === 'ice'
          ? this.checkMedia(generation, mediaAttempt)
          : this.check(generation);
      check();
      if ('lease' in request && request.lease !== this.lease)
        throw new Error('DESKTOP_LEASE_EXPIRED');
      if (request.op === 'start' && this.starting) throw new Error('DESKTOP_BUSY');
      // The renderer has no generic local clipboard API, password bridge, or lock-on-exit policy.
      if (
        request.op === 'clipboard' ||
        request.op === 'clipboardContent' ||
        request.op === 'presentation' ||
        (request.op === 'stop' && request.lockScreen)
      )
        throw new Error('DESKTOP_UNAVAILABLE');
      if (this.pending >= 12) throw new Error('DESKTOP_INPUT_BUSY');
      const target = this.target!,
        owner = this.owner;
      const isStart = request.op === 'start';
      const isControl = request.op === 'control';
      if (isControl || request.op === 'stop' || isStart) {
        this.controlGeneration++;
        this.wantsControl = isControl && request.enabled;
        this.controlling = false;
        if (!isControl) this.controlPending = false;
      }
      const controlGeneration = this.controlGeneration;
      const controlPendingAtStart = this.controlPending;
      if (isControl) this.controlPending = true;
      if (isStart) {
        this.starting = true;
      }
      this.pending++;
      try {
        const execute = async () => {
          check();
          if ('lease' in request && request.lease !== this.lease)
            throw new Error('DESKTOP_LEASE_EXPIRED');
          if (isStart) this.attempted = true;
          const result = await this.deps.request(target.deviceId, request, check);
          if (isStart) {
            const lease = result as RemoteDesktopLease;
            if (!lease || typeof lease.lease !== 'string') throw new Error('DESKTOP_UNAVAILABLE');
            if (!this.active || generation !== this.generation || owner !== this.deps.owner()) {
              if (owner === this.deps.owner())
                await this.deps
                  .request(target.deviceId, { op: 'stop', lease: lease.lease }, () => {
                    if (owner !== this.deps.owner()) throw new Error('DESKTOP_STOPPED');
                  })
                  .catch(() => {});
              throw new Error('DESKTOP_STOPPED');
            }
            this.lease = lease.lease;
          }
          this.check(generation);
          if (
            controlGeneration === this.controlGeneration &&
            (isControl ||
              (request.op === 'heartbeat' && !controlPendingAtStart && !this.controlPending))
          ) {
            this.controlling =
              this.wantsControl &&
              !!result &&
              typeof result === 'object' &&
              'controlling' in result &&
              result.controlling === true;
          }
          if (request.op === 'stop' && this.lease === request.lease) this.lease = null;
          return result;
        };
        const result = await (isStart || request.op === 'stop'
          ? this.serializeLifecycle(execute)
          : execute());
        return { ok: true, result };
      } finally {
        this.pending--;
        if (isControl && controlGeneration === this.controlGeneration) this.controlPending = false;
        if (generation === this.generation && isStart) this.starting = false;
      }
    } catch (error) {
      return viewerFailure(error);
    }
  }
  async clipboard(generation: number, action: unknown): Promise<RemoteViewerReply> {
    const transfer = {};
    try {
      this.check(generation);
      const lease = this.lease;
      if (!lease) throw new Error('DESKTOP_LEASE_EXPIRED');
      if (!this.controlling) throw new Error('DESKTOP_VIEW_ONLY');
      if (this.clipboardPending) throw new Error('DESKTOP_CLIPBOARD_BUSY');
      this.clipboardPending = transfer;
      const controlGeneration = this.controlGeneration;
      const check = () => {
        this.check(generation);
        if (this.lease !== lease) throw new Error('DESKTOP_LEASE_EXPIRED');
        if (!this.controlling || controlGeneration !== this.controlGeneration)
          throw new Error('DESKTOP_VIEW_ONLY');
      };
      if (action === 'copy') {
        const result = (await this.deps.request(
          this.target!.deviceId,
          { op: 'clipboard', lease, action: 'copy' },
          check,
        )) as { text?: unknown };
        check();
        if (
          typeof result.text !== 'string' ||
          !result.text ||
          result.text.length > REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS
        )
          throw new Error('CLIPBOARD_TOO_LONG');
        this.deps.writeClipboard(result.text);
      } else if (action === 'paste') {
        const text = this.deps.readClipboard();
        if (!text || text.length > REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS)
          throw new Error('CLIPBOARD_TOO_LONG');
        await this.deps.request(
          this.target!.deviceId,
          { op: 'clipboard', lease, action: 'paste', text },
          check,
        );
        check();
      } else throw new Error('INVALID_REQUEST');
      return { ok: true, result: null };
    } catch (error) {
      return viewerFailure(error);
    } finally {
      if (this.clipboardPending === transfer) this.clipboardPending = null;
    }
  }
}

/** Only stable codes cross the dedicated bridge; never raw IPC/OS error text. */
export function viewerFailure(error: unknown): RemoteViewerReply {
  const value = error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? value : 'DESKTOP_UNAVAILABLE';
  return { ok: false, code };
}
