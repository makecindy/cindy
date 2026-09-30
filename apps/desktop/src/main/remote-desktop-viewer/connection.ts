import {
  parseRemoteDesktopRequest,
  isDesktopAttemptId,
  REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS,
  type RemoteDesktopRequest,
  type RemoteDesktopLease,
  type RemoteDesktopCapabilities,
  transferClipboardContent,
} from '@cindy/device-link';
import type {
  RemoteViewerReply,
  RemoteViewerTarget,
  RemoteViewerState,
} from '../../shared/remoteDesktopViewer.js';
import {
  DEFAULT_VIEWER_PREFERENCES,
  type RemoteViewerPreferences,
  type RemoteViewerSafety,
} from '../../shared/remoteDesktopViewer.js';
import { ViewerSafety, type ViewerClipboard } from './safety.js';
import type { ViewerCredentials } from './credentials.js';

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
  private caps: RemoteDesktopCapabilities | null = null;
  private preferencesValue = { ...DEFAULT_VIEWER_PREFERENCES };
  private safetyState = new ViewerSafety();
  private clipboardProgress: number | null = null;
  private closing = false;
  constructor(
    private readonly deps: {
      owner(): string;
      request(deviceId: string, request: RemoteDesktopRequest, check: () => void): Promise<unknown>;
      readClipboard(): string;
      writeClipboard(value: string): void;
      clipboard?: ViewerClipboard;
      credentials?: Pick<ViewerCredentials, 'run' | 'dispose'>;
      focused?(): boolean;
      preferences?(device: string): RemoteViewerPreferences;
      savePreferences?(
        device: string,
        patch: Partial<RemoteViewerPreferences>,
      ): Promise<RemoteViewerPreferences>;
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
    this.caps = null;
    this.closing = false;
    this.preferencesValue = this.deps.preferences?.(target.deviceId) ?? {
      ...DEFAULT_VIEWER_PREFERENCES,
    };
    this.safetyState.invalidate(true);
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
    this.closing = false;
    this.safetyState.invalidate();
    this.clipboardProgress = null;
    this.deps.credentials?.dispose();
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
      if (this.closing) throw new Error('DESKTOP_STOPPED');
      const request = parseRemoteDesktopRequest(value);
      const check = () =>
        request.op === 'offer' || request.op === 'ice'
          ? this.checkMedia(generation, mediaAttempt)
          : this.check(generation);
      check();
      if ('lease' in request && request.lease !== this.lease)
        throw new Error('DESKTOP_LEASE_EXPIRED');
      if (request.op === 'start' && this.starting) throw new Error('DESKTOP_BUSY');
      // Clipboard contents and credentials are handled only by dedicated Main adapters.
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
        this.safetyState.invalidate();
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
          if (request.op === 'capabilities') {
            check();
            this.caps = result as RemoteDesktopCapabilities;
          }
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
            const wasControlling = this.controlling;
            this.controlling =
              this.wantsControl &&
              !!result &&
              typeof result === 'object' &&
              'controlling' in result &&
              result.controlling === true;
            if (wasControlling && !this.controlling) this.safetyState.invalidate();
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
      if (action !== 'copy' && action !== 'paste') throw new Error('INVALID_REQUEST');
      if (this.caps?.clipboardContent && this.deps.clipboard) {
        const current = () => {
          try {
            check();
            return true;
          } catch {
            return false;
          }
        };
        await this.safetyState.pause();
        check();
        this.clipboardProgress = 0;
        await transferClipboardContent(
          action,
          lease,
          async (message) => {
            check();
            const result = await this.deps.request(this.target!.deviceId, message, check);
            check();
            return result as never;
          },
          check,
          {
            read: () => this.deps.clipboard!.read(current),
            write: async (json) => {
              await this.deps.clipboard!.write(json, undefined, current);
            },
            progress: (done, total) => {
              if (current()) this.clipboardProgress = done / total;
            },
          },
        );
      } else if (action === 'copy') {
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
      if (this.clipboardPending === transfer) {
        this.clipboardPending = null;
        this.clipboardProgress = null;
      }
    }
  }
  async preferences(
    generation: number,
    patch?: Partial<RemoteViewerPreferences>,
  ): Promise<RemoteViewerPreferences> {
    this.check(generation);
    if (patch !== undefined) {
      if (!this.deps.savePreferences) throw new Error('DESKTOP_UNAVAILABLE');
      const value = await this.deps.savePreferences(this.target!.deviceId, patch);
      this.check(generation);
      const reset = value.clipboardSync !== this.preferencesValue.clipboardSync;
      this.preferencesValue = value;
      this.safetyState.invalidate(reset);
    }
    return { ...this.preferencesValue };
  }
  async focusChanged(): Promise<void> {
    const generation = this.generation;
    // Cancel local reads immediately, then reconcile after any old enable has
    // settled. Use current focus when reconciling (blur/focus may race).
    await this.safetyState.pauseClipboard();
    if (!this.active || generation !== this.generation) return;
    await this.safety(generation).catch(() => {});
  }
  async safety(generation: number, retry = false): Promise<RemoteViewerSafety> {
    this.check(generation);
    if (retry) this.safetyState.invalidate(true);
    const lease = this.lease,
      revision = this.controlGeneration;
    const current = () => {
      try {
        this.check(generation);
        return this.controlling && this.lease === lease && this.controlGeneration === revision;
      } catch {
        return false;
      }
    };
    const value =
      lease && this.caps
        ? await this.safetyState.tick({
            lease,
            caps: this.caps,
            preferences: {
              ...this.preferencesValue,
              clipboardSync: this.preferencesValue.clipboardSync && (this.deps.focused?.() ?? true),
            },
            current,
            clipboardCurrent: () =>
              current() && !this.clipboardPending && (this.deps.focused?.() ?? true),
            clipboard: this.deps.clipboard,
            request: async (message, check) => {
              check();
              const result = await this.deps.request(this.target!.deviceId, message, check);
              check();
              return result as never;
            },
          })
        : this.safetyState.snapshot();
    this.check(generation);
    return { ...value, clipboardProgress: this.clipboardProgress };
  }
  async credential(generation: number, action: unknown, enabled: unknown) {
    this.check(generation);
    if (this.closing) throw new Error('DESKTOP_STOPPED');
    if (!this.deps.credentials) throw new Error('CREDENTIAL_UNAVAILABLE');
    return this.deps.credentials.run(
      this.target!.deviceId,
      this.caps?.platform,
      action,
      enabled,
      () => {
        this.check(generation);
        if (this.closing) throw new Error('DESKTOP_STOPPED');
      },
    );
  }
  async close(generation: number): Promise<void> {
    this.check(generation);
    if (this.closing) throw new Error('DESKTOP_INPUT_BUSY');
    this.closing = true;
    this.deps.credentials?.dispose();
    const lease = this.lease;
    if (!lease) return;
    const lockScreen = this.preferencesValue.lockOnExit && this.caps?.lockOnExit === true;
    this.safetyState.invalidate();
    this.controlling = false;
    this.controlGeneration++;
    try {
      await this.serializeLifecycle(async () => {
        this.check(generation);
        if (this.lease !== lease) return;
        await this.deps.request(
          this.target!.deviceId,
          { op: 'stop', lease, ...(lockScreen ? { lockScreen: true } : {}) },
          () => this.check(generation),
        );
        this.check(generation);
        if (this.lease === lease) this.lease = null;
      });
    } catch (error) {
      if (generation === this.generation) this.closing = false;
      throw error;
    }
  }
}

/** Only stable codes cross the dedicated bridge; never raw IPC/OS error text. */
export function viewerFailure(error: unknown): RemoteViewerReply {
  const value = error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? value : 'DESKTOP_UNAVAILABLE';
  return { ok: false, code };
}
