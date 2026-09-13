import {
  DESKTOP_KEY_CODES,
  REMOTE_DESKTOP_NETWORK,
  REMOTE_DESKTOP_ICE_SERVERS,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  RemoteDesktopViewerSession,
  RemoteDesktopViewerMedia,
  remoteDesktopFailureKey,
  isDesktopInput,
  type RemoteDesktopCapabilities,
  type RemoteDesktopVideoSettings,
  type RemoteDesktopRequest,
  type DesktopInput,
} from '@cindy/device-link';
import { mountRemoteDesktopViewer } from '@cindy/maker-shared/remote-desktop-viewer';
import { extractIpcError } from '@/utils/ipcError';
import type {
  RemoteDesktopViewerApi,
  RemoteViewerState,
} from '../../../shared/remoteDesktopViewer';

export interface ViewerSnapshot {
  target: RemoteViewerState['target'];
  status: string;
  error: string | null;
  clipboardError?: boolean;
  controlling: boolean;
  controlPending: boolean;
  caps: RemoteDesktopCapabilities | null;
  displayId: string;
  transport: '' | 'video' | 'direct' | 'relay' | 'screenshots';
  latency: number | null;
  settings: RemoteDesktopVideoSettings;
  ready: boolean;
}

/** Desktop presentation adapter. Reuses the Mobile lease, browser media and
 * input queue; only window visibility and native clipboard live on Desktop.
 */
export class DesktopViewerController {
  private state: ViewerSnapshot = {
    target: null,
    status: 'connecting',
    error: null,
    controlling: false,
    controlPending: false,
    caps: null,
    displayId: '',
    transport: '',
    latency: null,
    settings: { fps: 30, bitrate: 0, audio: true },
    ready: false,
  };
  private scope: RemoteViewerState = { target: null, active: false, generation: -1 };
  private disposed = false;
  private opening = false;
  private epoch = 0;
  private resuming = false;
  private wantsControl = true;
  private retryAt = 0;
  private retryDelay = 1000;
  private frameBusy: string | null = null;
  private heartbeatBusy: string | null = null;
  private streaming = false;
  private clipboardQueue: Promise<void> = Promise.resolve();
  private clipboardQueued = 0;
  private clipboardRevision = 0;
  private session: RemoteDesktopViewerSession;
  private media: RemoteDesktopViewerMedia;
  private runtime: ReturnType<typeof mountRemoteDesktopViewer>;
  private timers: ReturnType<typeof setInterval>[];
  private unsubscribers: (() => void)[];
  constructor(
    private readonly api: RemoteDesktopViewerApi,
    root: HTMLElement,
    private readonly changed: (state: ViewerSnapshot) => void,
  ) {
    this.session = new RemoteDesktopViewerSession(this.request);
    this.media = new RemoteDesktopViewerMedia({
      request: this.request,
      send: (message) => this.runtime.receive(message),
      loadIce: (attempt) => api.ice(this.scope.generation, attempt),
      current: () =>
        this.session.lease && this.state.caps
          ? {
              lease: this.session.lease,
              caps: this.state.caps,
              settings: {
                ...this.state.settings,
                audio: this.state.settings.audio && this.state.caps.systemAudio === true,
              },
            }
          : null,
    });
    this.runtime = mountRemoteDesktopViewer(root, (message) => this.message(message), {
      desktop: true,
      net: REMOTE_DESKTOP_NETWORK,
      iceServers: REMOTE_DESKTOP_ICE_SERVERS,
      keyCodes: DESKTOP_KEY_CODES,
    });
    this.unsubscribers = [api.onActive((scope) => this.updateScope(scope))];
    void api
      .state()
      .then((scope) => this.updateScope(scope))
      .catch(() => {});
    this.timers = [
      setInterval(() => void this.heartbeat(), 3000),
      setInterval(() => void this.frame(), 350),
    ];
  }
  private publish(patch: Partial<ViewerSnapshot>): void {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.changed(this.state);
  }
  private request = async <T>(
    request: RemoteDesktopRequest,
    beforeSend?: () => void,
  ): Promise<T> => {
    beforeSend?.();
    const scope = this.scope;
    if (!scope.active || this.disposed) throw new Error('DESKTOP_STOPPED');
    try {
      return (await this.api.request(
        scope.generation,
        request,
        request.op === 'offer' || request.op === 'ice' ? this.media.attemptId : undefined,
      )) as T;
    } catch (error) {
      throw new Error(extractIpcError(error)?.message ?? 'DESKTOP_UNAVAILABLE');
    }
  };
  private updateScope(scope: RemoteViewerState): void {
    if (this.disposed || scope.generation < this.scope.generation) return;
    if (scope.generation === this.scope.generation && scope.active === this.scope.active) return;
    this.cancel();
    this.scope = scope;
    this.resuming = scope.resume === true;
    this.retryDelay = 1000;
    this.publish({
      target: scope.target,
      error: null,
      status: 'connecting',
      caps: null,
      ready: false,
    });
    if (scope.active) void this.connect();
  }
  private cancel(preserveFrame = false): void {
    this.epoch++;
    this.clipboardQueue = Promise.resolve();
    this.clipboardQueued = 0;
    this.opening = false;
    this.streaming = false;
    this.media.reset();
    this.runtime?.receive({ type: 'releaseInput' });
    void this.session.stop().catch(() => {});
    this.runtime?.receive({ type: 'stop', preserveFrame });
    this.publish({
      controlling: false,
      controlPending: false,
      ready: false,
      transport: '',
      latency: null,
      clipboardError: false,
    });
  }
  private async connect(takeover = false): Promise<void> {
    if (this.opening || !this.scope.active || this.disposed) return;
    this.opening = true;
    const epoch = this.epoch;
    this.publish({
      error: null,
      status: this.resuming ? 'reconnecting' : 'connecting',
      ready: false,
    });
    try {
      const resume = this.resuming;
      const { caps, lease } = await this.session.connect({
        displayId: this.state.displayId || undefined,
        resume,
        takeover,
        isCurrent: () => this.epoch === epoch && !this.disposed && this.scope.active,
        onCapabilities: (caps) => this.publish({ caps }),
        onStart: () => { this.resuming = true; },
      });
      if (epoch !== this.epoch) return;
      this.publish({ caps, displayId: lease.display.id, status: 'connecting' });
      this.runtime.receive({
        type: 'init',
        epoch: lease.lease,
        width: lease.display.width,
        height: lease.display.height,
        fillHeight: false,
        trickleIce: caps.trickleIce === true,
        audio: caps.systemAudio && this.state.settings.audio,
        clipboardShortcuts: caps.clipboardText === true,
        clipboardModifier:
          typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin'
            ? 'meta'
            : 'control',
      });
      this.runtime.receive({ type: 'mode', mode: 'pointer' });
      if (caps.canControl && this.wantsControl) await this.setControl(true);
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
    } finally {
      if (epoch === this.epoch) this.opening = false;
    }
  }
  private fail(error: unknown): void {
    const code = error instanceof Error ? error.message : '';
    const blocked = remoteDesktopFailureKey(code);
    this.cancel(true);
    this.publish({ status: 'reconnecting', error: blocked });
    this.retryAt = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(15000, this.retryDelay * 2);
  }
  retry(): void {
    this.cancel(true);
    this.resuming = false;
    void this.connect(this.state.error === 'connectionBusy');
  }
  async setControl(enabled: boolean): Promise<void> {
    if (this.state.controlPending || !this.session.lease) return;
    this.wantsControl = enabled;
    this.runtime.receive({ type: 'releaseInput' });
    const lease = this.session.lease;
    this.publish({ controlPending: true });
    this.syncControl();
    try {
      const result = await this.session.control(enabled);
      if (lease !== this.session.lease) return;
      if (!result.controlling) this.wantsControl = false;
      this.publish({ error: null });
    } catch (error) {
      if (lease !== this.session.lease) return;
      this.wantsControl = false;
      const code = error instanceof Error ? error.message : '';
      if (/DESKTOP_(LEASE_EXPIRED|STOPPED|DISABLED)|ACCESS_REVOKED|REMOTE_DISABLED/.test(code)) {
        this.fail(error);
        return;
      }
      this.publish({ error: enabled ? (remoteDesktopFailureKey(code) ?? 'busy') : null });
    } finally {
      if (lease === this.session.lease) {
        this.publish({ controlPending: false });
        this.syncControl();
      }
    }
  }
  /** Buttons and actual keyboard/mouse forwarding use the same confirmed state.
   * Menu focus only releases held keys; it does not revoke desktop control. */
  private syncControl(): void {
    const controlling =
      this.state.ready &&
      this.wantsControl &&
      !this.state.controlPending &&
      this.session.lease?.controlling === true;
    if (controlling === this.state.controlling) return;
    this.clipboardRevision++;
    this.publish({ controlling });
    this.runtime.receive({ type: 'control', enabled: controlling });
  }
  selectDisplay(displayId: string): void {
    if (
      !this.state.caps?.displays.some((d) => d.id === displayId) ||
      displayId === this.state.displayId
    )
      return;
    this.cancel(true);
    this.resuming = false;
    this.publish({ displayId });
    void this.connect();
  }
  settings(patch: Partial<RemoteDesktopVideoSettings>): void {
    this.publish({ settings: { ...this.state.settings, ...patch } });
    this.runtime.receive({
      type: 'videoSettings',
      audio: this.state.settings.audio && this.state.caps?.systemAudio === true,
    });
  }
  releaseInput(): void {
    this.runtime.receive({ type: 'releaseInput' });
  }
  fit(): void {
    this.runtime.receive({ type: 'fit' });
  }
  keys(codes: string[]): void {
    if (!this.state.controlling) return;
    const events: DesktopInput[] = [
      ...codes.map((code) => ({ kind: 'key' as const, code, down: true })),
      ...codes
        .slice()
        .reverse()
        .map((code) => ({ kind: 'key' as const, code, down: false })),
    ];
    this.runtime.receive({ type: 'events', events });
  }
  async clipboard(action: 'copy' | 'paste'): Promise<void> {
    if (!this.state.controlling) throw new Error('DESKTOP_VIEW_ONLY');
    if (this.clipboardQueued >= 8) throw new Error('CLIPBOARD_BUSY');
    const epoch = this.epoch;
    const generation = this.scope.generation;
    const revision = this.clipboardRevision;
    if (this.clipboardQueued === 0) this.clipboardQueue = Promise.resolve();
    this.clipboardQueued++;
    this.releaseInput();
    this.publish({ clipboardError: false });
    const transfer = this.clipboardQueue.then(async () => {
      if (
        epoch !== this.epoch ||
        revision !== this.clipboardRevision ||
        this.disposed ||
        !this.state.controlling
      )
        throw new Error('DESKTOP_STOPPED');
      await this.api.clipboard(generation, action);
    });
    this.clipboardQueue = transfer;
    try {
      await transfer;
    } finally {
      if (epoch === this.epoch) this.clipboardQueued--;
    }
  }
  async permissionGuide(): Promise<void> {
    await this.request({ op: 'permissions', action: 'guide' });
  }
  displayModes() {
    const lease = this.session.lease;
    if (!lease) return Promise.resolve([]);
    return this.request<import('@cindy/device-link').RemoteDesktopDisplayMode[]>({
      op: 'displayModes',
      lease: lease.lease,
    });
  }
  async resolution(modeId: string): Promise<void> {
    const lease = this.session.lease;
    if (!lease) return;
    await this.request({ op: 'resolution', lease: lease.lease, modeId });
    this.cancel(true);
    this.resuming = false;
    void this.connect();
  }
  private async heartbeat(): Promise<void> {
    if (!this.scope.active || this.disposed) return;
    if (!this.session.lease) {
      if (!this.state.error && Date.now() >= this.retryAt) void this.connect();
      return;
    }
    const leaseId = this.session.lease.lease;
    if (this.heartbeatBusy === leaseId) return;
    this.heartbeatBusy = leaseId;
    const epoch = this.epoch;
    try {
      const result = await this.session.heartbeat();
      if (epoch === this.epoch) {
        if (!result.controlling && this.state.controlling) this.wantsControl = false;
        this.syncControl();
      }
    } catch (error) {
      if (epoch === this.epoch && !(error instanceof Error && error.message === 'INVOKE_TIMEOUT'))
        this.fail(error);
    } finally {
      if (this.heartbeatBusy === leaseId) this.heartbeatBusy = null;
    }
  }
  private async frame(): Promise<void> {
    const lease = this.session.lease;
    if (!lease || this.streaming || this.frameBusy === lease.lease || !this.scope.active) return;
    this.frameBusy = lease.lease;
    try {
      const result = await this.request<{ jpeg: string | null; cursor?: unknown }>({
        op: 'frame',
        lease: lease.lease,
        cursorOverlay: this.state.caps?.cursorOverlay === true,
      });
      if (
        this.session.lease === lease &&
        !this.streaming &&
        typeof result.jpeg === 'string' &&
        result.jpeg.length <= Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4
      )
        this.runtime.receive({
          type: 'frame',
          jpeg: result.jpeg,
          ...('cursor' in result ? { cursor: result.cursor } : {}),
        });
    } catch (error) {
      if (this.session.lease === lease) this.fail(error);
    } finally {
      if (this.frameBusy === lease.lease) this.frameBusy = null;
    }
  }
  private message(message: Record<string, unknown>): void {
    const lease = this.session.lease;
    if (!lease || message.epoch !== lease.lease || this.disposed) return;
    if (['iceConfig', 'offer', 'ice'].includes(String(message.type))) {
      void this.media.handle(message).catch((error) => {
        if (this.session.lease === lease) this.fail(error);
      });
      return;
    }
    switch (message.type) {
      case 'clipboard': {
        if (
          !this.state.controlling ||
          !this.state.caps?.clipboardText ||
          (message.action !== 'copy' && message.action !== 'paste')
        )
          break;
        const epoch = this.epoch;
        void this.clipboard(message.action).catch(() => {
          if (epoch === this.epoch && !this.disposed) this.publish({ clipboardError: true });
        });
        break;
      }
      case 'streaming':
        this.streaming = true;
        this.publish({ transport: 'video', latency: null });
        this.present('live');
        break;
      case 'framePresented':
        if (this.streaming) break;
        this.publish({ transport: 'screenshots', latency: null });
        this.present('compatibility');
        break;
      case 'fallback':
        this.streaming = false;
        this.publish({ transport: 'screenshots', status: 'compatibility', latency: null });
        break;
      case 'reconnecting':
        this.publish({ status: 'reconnecting' });
        break;
      case 'network': {
        const transport = message.transport;
        // Only the presented video may supply its route/RTT. JPEG fallback
        // must not inherit a previous video's route or latency.
        if (
          !this.streaming ||
          (transport !== 'video' && transport !== 'direct' && transport !== 'relay')
        )
          break;
        this.publish({
          transport,
          latency:
            typeof message.latencyMs === 'number' &&
            Number.isFinite(message.latencyMs) &&
            message.latencyMs >= 0
              ? message.latencyMs
              : null,
        });
        break;
      }
      case 'inputOverflow':
        void this.setControl(false);
        break;
      case 'input':
        if (
          !Number.isSafeInteger(message.sequence) ||
          !Array.isArray(message.events) ||
          message.events.length > 64 ||
          !message.events.every(isDesktopInput)
        )
          return;
        void this.request({
          op: 'input',
          lease: lease.lease,
          sequence: message.sequence as number,
          events: message.events,
        })
          .catch(() => {
            if (this.session.lease === lease) void this.setControl(false);
          })
          .finally(() => {
            if (this.session.lease === lease)
              this.runtime.receive({ type: 'ack', epoch: lease.lease, sequence: message.sequence });
          });
        break;
    }
  }
  private present(status: string): void {
    this.retryDelay = 1000;
    this.publish({ ready: true, status });
    this.syncControl();
  }
  dispose(): void {
    this.cancel();
    this.disposed = true;
    for (const t of this.timers) clearInterval(t);
    for (const off of this.unsubscribers) off();
    this.runtime.dispose();
  }
}
