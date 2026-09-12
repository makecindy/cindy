import type {
  RemoteDesktopCapabilities,
  RemoteDesktopLease,
  RemoteDesktopRequest,
} from "./remoteDesktop.js";

export type DesktopViewerRequest = <T>(
  request: RemoteDesktopRequest,
  beforeSend?: () => void,
) => Promise<T>;

/** Local lifecycle callbacks do not change the remote wire protocol. */
interface ViewerConnectOptions {
  displayId?: string;
  resume?: boolean;
  takeover?: boolean;
  isCurrent: () => boolean;
  onCapabilities?: (caps: RemoteDesktopCapabilities) => void;
  onStart?: () => void;
}

/** Viewer-side lease ownership, shared by native Mobile and the Desktop window.
 * A viewer never owns the shared Device Link: stop releases only its own lease.
 */
export class RemoteDesktopViewerSession {
  private generation = 0;
  private active: RemoteDesktopLease | null = null;
  private controlPending: Promise<unknown> | null = null;
  private controlGeneration = 0;
  private releaseUnconfirmed = false;
  private lifecycle: Promise<void> | null = null;
  constructor(private readonly request: DesktopViewerRequest) {}

  get lease(): RemoteDesktopLease | null {
    return this.active;
  }

  connect(
    options: ViewerConnectOptions,
  ): Promise<{ caps: RemoteDesktopCapabilities; lease: RemoteDesktopLease }> {
    const generation = ++this.generation;
    return this.serialize(() => this.startConnection(generation, options));
  }

  /** A cancelled start must finish retiring its lease before this viewer starts again. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    let pending: Promise<T>;
    try {
      // Idle teardown dispatches immediately, preserving Mobile's exit-lock ordering.
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

  private async startConnection(
    generation: number,
    options: ViewerConnectOptions,
  ): Promise<{ caps: RemoteDesktopCapabilities; lease: RemoteDesktopLease }> {
    const check = () => {
      if (generation !== this.generation || !options.isCurrent())
        throw new Error("DESKTOP_VIDEO_STOPPED");
    };
    check();
    const caps = await this.request<RemoteDesktopCapabilities>(
      { op: "capabilities" },
      check,
    );
    check();
    if (caps?.version !== 1) throw new Error("CHANNEL_NOT_ALLOWED");
    if (!caps.enabled) throw new Error("DESKTOP_DISABLED");
    if (options.resume && !caps.automaticReconnect)
      throw new Error("CHANNEL_NOT_ALLOWED");
    options.onCapabilities?.(caps);
    check();
    const display =
      caps.displays.find((d) => d.id === options.displayId) ?? caps.displays[0];
    if (!display) throw new Error("DESKTOP_DISPLAY_MISSING");
    options.onStart?.();
    const lease = await this.request<RemoteDesktopLease>(
      {
        op: "start",
        displayId: display.id,
        ...(options.takeover && caps.connectionTakeover
          ? { takeover: true }
          : options.resume
            ? { resume: true }
            : {}),
      },
      check,
    );
    if (generation !== this.generation || !options.isCurrent()) {
      await this.request({ op: "stop", lease: lease.lease }).catch(() => {});
      throw new Error("DESKTOP_VIDEO_STOPPED");
    }
    this.active = lease;
    return { caps, lease };
  }

  async control(enabled: boolean): Promise<{ controlling: boolean }> {
    const lease = this.active;
    if (!lease) throw new Error("DESKTOP_LEASE_EXPIRED");
    if (this.controlPending) throw new Error("DESKTOP_INPUT_BUSY");
    if (enabled && this.releaseUnconfirmed)
      throw new Error("DESKTOP_INPUT_BUSY");
    this.controlGeneration++;
    if (!enabled) this.releaseUnconfirmed = true;
    const check = () => {
      if (this.active !== lease) throw new Error("DESKTOP_LEASE_EXPIRED");
    };
    const operation = this.request<{ controlling: boolean }>(
      { op: "control", lease: lease.lease, enabled },
      check,
    );
    this.controlPending = operation;
    try {
      const result = await operation;
      check();
      lease.controlling = result.controlling === true;
      if (!lease.controlling) this.releaseUnconfirmed = false;
      return { controlling: lease.controlling };
    } finally {
      if (this.controlPending === operation) this.controlPending = null;
    }
  }

  async heartbeat(): Promise<{ controlling: boolean }> {
    const lease = this.active;
    if (!lease) throw new Error("DESKTOP_LEASE_EXPIRED");
    const pendingAtStart = this.controlPending;
    const controlGeneration = this.controlGeneration;
    const result = await this.request<{ controlling: boolean }>({
      op: "heartbeat",
      lease: lease.lease,
    });
    if (this.active !== lease) throw new Error("DESKTOP_LEASE_EXPIRED");
    // Older/malformed heartbeats without a control projection are not evidence
    // that the host revoked control. Preserve the last confirmed state.
    if (!result || typeof result.controlling !== "boolean")
      return { controlling: lease.controlling };
    // A heartbeat sent before a control transition cannot acknowledge that transition.
    if (
      !pendingAtStart &&
      !this.controlPending &&
      controlGeneration === this.controlGeneration
    ) {
      lease.controlling = result.controlling === true;
      if (!lease.controlling) this.releaseUnconfirmed = false;
      else if (this.releaseUnconfirmed) {
        await this.control(false);
      }
    }
    return { controlling: lease.controlling };
  }

  stop(lockScreen = false): Promise<unknown> {
    this.generation++;
    const lease = this.active;
    this.active = null;
    this.controlPending = null;
    this.controlGeneration++;
    this.releaseUnconfirmed = false;
    return this.serialize(() =>
      lease
        ? this.request({
            op: "stop",
            lease: lease.lease,
            ...(lockScreen ? { lockScreen: true } : {}),
          })
        : Promise.resolve(),
    );
  }
}

/** Only transient connection errors may restart a viewer. Explicit stop wins. */
export function remoteDesktopFailureKey(code: string): string | null {
  if (/ACCESS_REVOKED/.test(code)) return "accessRevoked";
  if (/REMOTE_DISABLED/.test(code)) return "remoteDisabled";
  if (/DESKTOP_BUSY/.test(code)) return "connectionBusy";
  if (/CHANNEL_NOT_ALLOWED/.test(code)) return "upgrade";
  if (/DESKTOP_DISABLED/.test(code)) return "disabled";
  if (/PERMISSION|ACCESSIBILITY/.test(code)) return "permissionHint";
  if (/DESKTOP_STOPPED|DESKTOP_AUTHENTICATION_REQUIRED/.test(code))
    return "disconnected";
  return null;
}
