import {
  DESKTOP_KEY_CODES,
  REMOTE_DESKTOP_NETWORK,
  REMOTE_DESKTOP_ICE_SERVERS,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  RemoteDesktopViewerSession,
  REMOTE_DESKTOP_CONNECTION_TIMEOUT_MS,
  viewerDisplaySize,
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
import {
  DEFAULT_VIEWER_PREFERENCES,
  type RemoteViewerPreferences,
  type RemoteViewerSafety,
  type RemoteViewerCredentialState,
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
  scaleMode?: 'fit' | 'actual' | 'custom';
  preferences: RemoteViewerPreferences;
  safety: RemoteViewerSafety;
  receiveRate: number | null;
  closing: boolean;
  credential: RemoteViewerCredentialState | null;
  credentialBusy: boolean;
  credentialNotice: string | null;
}

function connectionBudget(caps: RemoteDesktopCapabilities | null): number {
  // Match Mobile: system consent has its own two-minute host deadline.
  return (
    REMOTE_DESKTOP_CONNECTION_TIMEOUT_MS +
    (caps?.displays.some((display) => display.id === 'wayland-portal') ? 120_000 : 0)
  );
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
    preferences: { ...DEFAULT_VIEWER_PREFERENCES },
    safety: { privacyActive: false, notice: null, clipboardProgress: null },
    receiveRate: null,
    closing: false,
    credential: null,
    credentialBusy: false,
    credentialNotice: null,
  };
  private scope: RemoteViewerState = { target: null, active: false, generation: -1 };
  private disposed = false;
  private opening = false;
  private epoch = 0;
  private resuming = false;
  private wantsControl = true;
  private retryAt = 0;
  private retryDelay = 1000;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private frameBusy: string | null = null;
  private heartbeatBusy: string | null = null;
  private streaming = false;
  private clipboardQueue: Promise<void> = Promise.resolve();
  private clipboardQueued = 0;
  private clipboardRevision = 0;
  private pendingSettings = false;
  private offers = new Set<import('@cindy/device-link').RemoteDesktopLease>();
  private mediaChanging = false;
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  private statsAt = 0;
  private frameAt = 0;
  private unlockAttempted = false;
  private credentialRetry: {
    action: 'settings' | 'enable' | 'disable' | 'unlock' | 'biometric';
    enabled?: boolean;
  } | null = null;
  private session: RemoteDesktopViewerSession;
  private media: RemoteDesktopViewerMedia;
  private runtime: ReturnType<typeof mountRemoteDesktopViewer>;
  private timers: ReturnType<typeof setInterval>[];
  private unsubscribers: (() => void)[];
  constructor(
    private readonly api: RemoteDesktopViewerApi,
    private readonly root: HTMLElement,
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
      onOfferStart: (lease) => {
        this.offers.add(lease);
      },
      onOfferSettled: (lease) => {
        this.offers.delete(lease);
        this.applySettings();
      },
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
      setInterval(() => {
        void this.refreshSafety();
        if (this.statsAt && Date.now() - this.statsAt > 5000)
          this.publish({ receiveRate: null, latency: null });
      }, 1500),
    ];
  }
  private publish(patch: Partial<ViewerSnapshot>): void {
    const previousBudget = connectionBudget(this.state.caps);
    this.state = { ...this.state, ...patch };
    const budget = connectionBudget(this.state.caps);
    // Capabilities arrive after the initial timer starts. Change its budget
    // only when the backend changes, never on repeated caps or media retries.
    if (budget !== previousBudget && this.connectionTimer !== null) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
    const waiting =
      this.scope.active &&
      !this.disposed &&
      !this.state.error &&
      !this.state.closing &&
      (!this.state.ready || this.state.status === 'reconnecting');
    if (!waiting) {
      if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    } else if (this.connectionTimer === null) {
      // Transient failures and media fallback must not renew the total budget.
      this.connectionTimer = setTimeout(() => {
        this.fail(new Error('DESKTOP_CONNECTION_TIMEOUT'));
      }, budget);
    }
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
    if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    this.scope = scope;
    this.resuming = scope.resume === true;
    this.retryDelay = 1000;
    this.publish({
      target: scope.target,
      error: null,
      status: 'connecting',
      caps: null,
      ready: false,
      closing: false,
      credential: null,
      credentialBusy: false,
      credentialNotice: null,
      preferences: { ...DEFAULT_VIEWER_PREFERENCES },
    });
    this.unlockAttempted = false;
    this.credentialRetry = null;
    if (scope.active)
      void (async () => {
        try {
          const preferences = await this.api.preferences?.(scope.generation);
          if (this.scope !== scope || this.disposed) return;
          if (preferences)
            this.publish({
              preferences,
              settings: { ...this.state.settings, audio: preferences.audio },
            });
        } catch {
          /* Defaults preserve ordinary viewing if preference storage is unavailable. */
        }
        if (this.scope === scope && !this.disposed) void this.connect();
      })();
  }
  private cancel(preserveFrame = false): void {
    this.epoch++;
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
    this.pendingSettings = false;
    this.mediaChanging = false;
    this.offers.clear();
    this.statsAt = 0;
    this.frameAt = 0;
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
      receiveRate: null,
      safety: { privacyActive: false, notice: null, clipboardProgress: null },
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
        onStart: () => {
          this.resuming = true;
        },
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
        clipboardShortcuts: caps.clipboardText === true || caps.clipboardContent === true,
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
    this.unlockAttempted = false;
    this.resuming = false;
    void this.connect(this.state.error === 'connectionBusy');
  }
  async setControl(enabled: boolean): Promise<void> {
    if (this.state.closing || this.state.controlPending || !this.session.lease) return;
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
        this.applySettings();
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
    if (patch.audio !== undefined) void this.preference({ audio: patch.audio });
    this.pendingSettings = true;
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => {
      this.settingsTimer = null;
      this.applySettings();
    }, 0);
  }
  private applySettings(): void {
    if (
      !this.pendingSettings ||
      !this.session.lease ||
      !this.state.ready ||
      this.state.closing ||
      this.offers.size ||
      this.state.controlPending ||
      this.mediaChanging ||
      !['live', 'compatibility'].includes(this.state.status)
    )
      return;
    this.pendingSettings = false;
    this.mediaChanging = true;
    this.runtime.receive({
      type: 'videoSettings',
      audio: this.state.settings.audio && this.state.caps?.systemAudio === true,
    });
  }
  async preference(patch: Partial<RemoteViewerPreferences>): Promise<void> {
    const scope = this.scope;
    try {
      const preferences = await this.api.preferences?.(scope.generation, patch);
      if (this.scope !== scope || this.disposed || !preferences) return;
      this.publish({ preferences });
      void this.refreshSafety();
    } catch {
      if (this.scope === scope)
        this.publish({ safety: { ...this.state.safety, notice: 'viewer.settingsFailed' } });
    }
  }
  async refreshSafety(retry = false): Promise<void> {
    if (!this.state.ready || this.state.closing || !this.api.safety) return;
    const epoch = this.epoch;
    try {
      const safety = await this.api.safety(this.scope.generation, retry);
      if (epoch === this.epoch && !this.disposed) this.publish({ safety });
    } catch {
      /* Connection state owns disconnected/retired generations. */
    }
  }
  async close(): Promise<void> {
    if (this.state.closing) return;
    this.releaseInput();
    this.publish({ closing: true });
    const epoch = this.epoch;
    try {
      await this.api.close(this.scope.generation);
    } catch (error) {
      if (epoch === this.epoch && !this.disposed) this.publish({ closing: false });
      throw error;
    }
  }
  async credential(
    action: 'settings' | 'enable' | 'disable' | 'unlock' | 'biometric',
    enabled?: boolean,
  ): Promise<void> {
    if (
      !this.api.credential ||
      this.state.credentialBusy ||
      !this.state.ready ||
      this.state.closing
    )
      return;
    const scope = this.scope;
    this.publish({ credentialBusy: true, credentialNotice: null });
    this.credentialRetry = { action, enabled };
    try {
      const credential = await this.api.credential(scope.generation, action, enabled);
      if (this.scope === scope && !this.disposed) {
        this.credentialRetry = null;
        this.publish({ credential });
      }
    } catch (error) {
      if (this.scope !== scope || this.disposed) return;
      const code = extractIpcError(error)?.message ?? String(error);
      if (action === 'unlock' && code.includes('PASSWORD_REJECTED'))
        this.credentialRetry = { action: 'enable' };
      if (!code.includes('CREDENTIAL_CANCELLED'))
        this.publish({
          credentialNotice: code.includes('SIGNING_REQUIRED')
            ? 'credentialSigningRequired'
            : code.includes('PASSWORD_REJECTED')
              ? 'credentialPasswordRejected'
              : code.includes('INVALID_IDENTITY')
                ? 'credentialIdentityChanged'
                : code.includes('ACCESSIBILITY_REQUIRED')
                  ? 'credentialAccessibilityRequired'
                  : code.includes('UNLOCK_UNAVAILABLE')
                    ? 'credentialUnlockUnavailable'
                    : 'credentialRequired',
        });
    } finally {
      if (this.scope === scope && !this.disposed) this.publish({ credentialBusy: false });
    }
  }
  retryCredential(): void {
    if (this.credentialRetry)
      void this.credential(this.credentialRetry.action, this.credentialRetry.enabled);
  }
  releaseInput(): void {
    this.runtime.receive({ type: 'releaseInput' });
  }
  actualSize(): void {
    const lease = this.session.lease;
    if (!lease || !this.state.ready) return;
    this.runtime.receive({ type: 'actualSize' });
    const toolbar = this.root.parentElement?.querySelector('.remote-viewer-toolbar');
    const toolbarHeight = toolbar?.getBoundingClientRect().height ?? 60;
    void this.api
      .resize(
        this.scope.generation,
        Math.ceil(lease.display.width),
        Math.ceil(lease.display.height + toolbarHeight),
      )
      .catch(() => {
        /* A closed or replaced viewer must not resize its successor. */
      });
  }
  fit(): void {
    this.runtime.receive({ type: 'fit' });
  }
  zoom(direction: 'in' | 'out'): void {
    this.runtime.receive({ type: 'zoom', factor: direction === 'in' ? 1.25 : 0.8 });
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
  async displayModes() {
    const lease = this.session.lease;
    if (!lease) return [];
    const modes = await this.request<import('@cindy/device-link').RemoteDesktopDisplayMode[]>({
      op: 'displayModes',
      lease: lease.lease,
    });
    if (this.session.lease !== lease) throw new Error('DESKTOP_STOPPED');
    return modes;
  }
  async resolution(modeId: string): Promise<void> {
    const lease = this.session.lease;
    if (!lease) return;
    if (
      this.state.caps?.resolutionRestore ||
      (this.state.caps?.viewerDisplay && this.state.caps.viewerDisplayRestore)
    ) {
      const mode = (await this.displayModes()).find((item) => item.id === modeId);
      if (this.session.lease !== lease) return;
      if (!mode) throw new Error('DESKTOP_DISPLAY_MODE_MISSING');
      if (
        this.state.caps?.resolutionRestore ||
        [mode.width, mode.height].every((size) => size >= 320 && size <= 2560)
      ) {
        await this.fitDisplay(
          mode.width,
          mode.height,
          true,
          this.state.caps?.resolutionRestore ? mode.id : undefined,
        );
        return;
      }
    }
    throw new Error('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
  }
  async fitDisplay(
    width: number,
    height: number,
    exactResolution = false,
    modeId?: string,
  ): Promise<void> {
    if (
      exactResolution &&
      !modeId &&
      ![width, height].every((value) => Number.isInteger(value) && value >= 320 && value <= 2560)
    )
      throw new Error('DESKTOP_DISPLAY_MODE_MISSING');
    const size = exactResolution ? { width, height } : viewerDisplaySize(width, height);
    const lease = this.session.lease;
    if (
      !size ||
      !lease?.controlling ||
      !(modeId ? this.state.caps?.resolutionRestore : this.state.caps?.viewerDisplay) ||
      this.state.controlPending
    )
      return;
    this.publish({ controlPending: true });
    this.syncControl();
    this.media.reset();
    const sourceDisplayId = this.state.displayId;
    try {
      const next = await this.session.fitDisplay(size.width, size.height, false, modeId);
      if (this.session.lease !== lease) return;
      const caps = this.state.caps;
      this.publish({
        // Keep the physical source as the reconnect target; the temporary
        // display is only the current capture/input surface.
        displayId: sourceDisplayId,
        // The temporary capture surface is lease state, never a reconnectable
        // display choice in the selector.
        caps,
      });
      this.streaming = false;
      this.runtime.receive({
        type: 'videoSettings',
        width: next.display.width,
        height: next.display.height,
        ...(modeId ? { restore: true } : {}),
        audio: this.state.settings.audio && this.state.caps?.systemAudio === true,
      });
      await this.session.control(true);
    } catch (error) {
      if (error instanceof Error && error.message === 'INVOKE_TIMEOUT') {
        this.cancel(true);
        void this.connect();
      }
      throw error;
    } finally {
      if (this.session.lease === lease) {
        this.publish({ controlPending: false });
        this.syncControl();
      }
    }
  }
  private async heartbeat(): Promise<void> {
    if (!this.scope.active || this.disposed || this.state.closing) return;
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
    if (
      !lease ||
      this.state.closing ||
      this.streaming ||
      this.frameBusy === lease.lease ||
      !this.scope.active
    )
      return;
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
      ) {
        const now = Date.now();
        this.publish({
          receiveRate:
            this.frameAt && now > this.frameAt
              ? (result.jpeg.length * 0.75 * 1000) / (now - this.frameAt)
              : null,
        });
        this.frameAt = now;
        this.statsAt = now;
        this.runtime.receive({
          type: 'frame',
          jpeg: result.jpeg,
          ...('cursor' in result ? { cursor: result.cursor } : {}),
        });
      }
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
      case 'scaleMode':
        if (message.mode === 'fit' || message.mode === 'actual' || message.mode === 'custom')
          this.publish({ scaleMode: message.mode });
        break;
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
        this.mediaChanging = false;
        this.streaming = false;
        this.publish({ transport: 'screenshots', status: 'compatibility', latency: null });
        this.applySettings();
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
          receiveRate:
            typeof message.bytesPerSecond === 'number' &&
            Number.isFinite(message.bytesPerSecond) &&
            message.bytesPerSecond >= 0
              ? message.bytesPerSecond
              : null,
          latency:
            typeof message.latencyMs === 'number' &&
            Number.isFinite(message.latencyMs) &&
            message.latencyMs >= 0
              ? message.latencyMs
              : null,
        });
        this.statsAt = Date.now();
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
    if (status === 'live') this.mediaChanging = false;
    this.retryDelay = 1000;
    this.publish({ ready: true, status });
    this.syncControl();
    this.applySettings();
    void this.refreshSafety();
    if (!this.unlockAttempted && this.state.caps?.platform === 'darwin') {
      this.unlockAttempted = true;
      void this.credential('unlock');
    }
  }
  dispose(): void {
    this.cancel();
    this.disposed = true;
    if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    for (const t of this.timers) clearInterval(t);
    for (const off of this.unsubscribers) off();
    this.runtime.dispose();
  }
}
