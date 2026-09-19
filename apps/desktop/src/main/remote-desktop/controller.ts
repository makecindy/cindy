import { ClipboardTransfer } from './clipboardTransfer';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger';
import type { ViewerDisplayHandle } from './viewerDisplay';
import {
  parseRemoteDesktopRequest,
  REMOTE_DESKTOP_LEASE_MS,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  type DesktopInput,
  type RemoteDesktopWindow,
  type RemoteDesktopCursorFrame,
  type RemoteClipboardContent,
  type RemoteDesktopVideoSettings,
  type RemoteDesktopDisplayMode,
  type RemoteDesktopCapabilities,
  type RemoteDesktopLease,
  type RemoteDesktopPermissions,
  type RemoteDesktopIceRequest,
  type RemoteDesktopIceReply,
  desktopPermissionReady,
} from '@cindy/device-link';

const log = createLogger('remote-desktop:controller');

export interface DesktopControllerDeps {
  /** Optional host setup before allocating the first lease or temporary output. */
  prepare?(current: () => boolean): Promise<void>;
  windowAction?(
    action: 'list' | 'activate' | 'desktop' | 'workspaceLeft' | 'workspaceRight' | 'omarchyMenu',
    id: string | undefined,
    displayId: string,
    current: () => boolean,
  ): Promise<RemoteDesktopWindow[] | null>;
  stopWindowActions?(): Promise<void>;
  authorized(peer: string): boolean;
  /**
   * Trusted host authentication provider, never a controller-supplied flag.
   * A nonempty ID identifies one verified credential session. Return null on
   * expiry/revocation or while authentication is pending. A replacement session
   * must have a new ID, even for the same peer. Omit only for legacy hosts that
   * do not advertise credential authentication.
   */
  authenticationSession?(peer: string): string | null;
  capabilities(): Promise<RemoteDesktopCapabilities>;
  permissions?(action: 'check' | 'guide'): Promise<RemoteDesktopPermissions>;
  frame(
    displayId: string,
    cursorOverlay?: boolean,
    lease?: string,
  ): Promise<string | RemoteDesktopCursorFrame | null>;
  startInput(displayId: string): Promise<void>;
  input(events: DesktopInput[]): void;
  stopInput(): void;
  releaseInput?(): Promise<void>;
  stopVideo(): void;
  lockScreen?(isCurrent: () => boolean, signal: AbortSignal): Promise<void>;
  offer(
    lease: RemoteDesktopLease,
    sdp: string,
    settings?: RemoteDesktopVideoSettings,
    cursorOverlay?: boolean,
    attemptId?: string,
  ): Promise<string>;
  ice?(request: RemoteDesktopIceRequest): Promise<RemoteDesktopIceReply>;
  displayModes?(displayId: string): Promise<RemoteDesktopDisplayMode[]>;
  /** Local hardware presence; must not hide displays when remote access is revoked. */
  displayPresent?(displayId: string): boolean | Promise<boolean>;
  resolution?(
    displayId: string,
    modeId: string,
    beforeChange: () => void,
    expected?: { width: number; height: number },
  ): Promise<void>;
  restoreResolution?(
    displayId: string,
    modeId: string,
    beforeChange: () => void,
    expected: { width: number; height: number },
  ): Promise<void>;
  createViewerDisplay?(
    displayId: string,
    isCurrent: () => boolean,
    onFailure: () => void,
  ): Promise<ViewerDisplayHandle>;
  clipboard?(
    action: 'copy' | 'paste',
    text: string | undefined,
    isCurrent: () => boolean,
  ): Promise<string | void>;
  clipboardContent?(
    action: 'copy' | 'paste',
    content: RemoteClipboardContent | undefined,
    isCurrent: () => boolean,
    options?: { sync?: boolean; version?: string },
  ): Promise<RemoteClipboardContent | { version: string } | void>;
  clipboardVersion?(): Promise<string>;
  privacyScreen?(enabled: boolean, isCurrent: () => boolean): Promise<void>;
  stopPrivacyScreen?(): void;
  hostMute?(enabled: boolean): Promise<void>;
  stopHostMute?(): Promise<void>;
  changed(): void;
  now?: () => number;
}

/** One human lease, peer-bound, with finite lifetime even if the relay disappears. */
export class RemoteDesktopController {
  private active:
    | (RemoteDesktopLease & {
        peer: string;
        readonly sourceDisplayId: string;
        expires: number;
        sequence: number;
        authenticationSession: string | undefined;
        backgroundViewing?: boolean;
        clipboardSync?: boolean;
        hostMute?: boolean;
        privacyLockOnExit?: boolean;
      })
    | null = null;
  private starting = false;
  private viewerDisplay: ViewerDisplayHandle | null = null;
  private displayRestoring: Promise<void> | null = null;
  private originalResolution: {
    displayId: string;
    modeId: string;
    width: number;
    height: number;
  } | null = null;
  private resolutionWrite: Promise<void> | null = null;
  private displayChanging = false;
  private viewerGeometryManaged = false;
  private locking = false;
  private lockAbort: AbortController | null = null;
  private startingPeer: string | null = null;
  private framePending = false;
  private clipboardPending = false;
  private syncGeneration = 0;
  private privacyGeneration = 0;
  private privacyOperation: { enabled: boolean; promise: Promise<{ enabled: boolean }> } | null =
    null;
  private async clearSafety(): Promise<void> {
    this.privacyGeneration++;
    this.privacyOperation = null;
    this.syncGeneration++;
    if (this.active) this.active.clipboardSync = false;
    try {
      this.deps.stopPrivacyScreen?.();
    } finally {
      await Promise.all([this.deps.stopHostMute?.(), this.deps.stopWindowActions?.()]);
    }
  }
  /** Revoke input synchronously; optional OS restoration must never retain it
   * or stop a replacement helper after an asynchronous restore settles.
   */
  private revokeControl(): Promise<void> {
    if (this.active) this.active.controlling = false;
    this.controlGeneration++;
    this.clipboardTransfer.reset();
    this.deps.stopInput();
    const restoring = this.clearSafety();
    this.deps.changed();
    return restoring;
  }
  private clipboardTransfer = new ClipboardTransfer();
  private lastFrame = -Infinity;
  private controlGeneration = 0;
  private inputStarting = false;
  private userStopped = new Map<string, string>();
  private lastEnded: { peer: string; lease: string } | null = null;
  constructor(private readonly deps: DesktopControllerDeps) {}
  get state(): { peer: string; controlling: boolean } | null {
    this.tick();
    return this.active ? { peer: this.active.peer, controlling: this.active.controlling } : null;
  }
  get displayId(): string | null {
    return this.active?.display.id ?? null;
  }
  /** Expected mirror events must not end the lease while its new geometry is prepared. */
  get changingDisplay(): boolean {
    return this.displayChanging;
  }
  displayGeometryMatches(id: string, width: number, height: number): boolean {
    const display = this.active?.display;
    return (
      this.viewerGeometryManaged &&
      display?.id === id &&
      display.width === width &&
      display.height === height
    );
  }
  hasLease(lease: string): boolean {
    this.tick();
    return this.active?.lease === lease;
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private authenticationSession(peer: string): string | undefined {
    if (!this.deps.authenticationSession) return undefined;
    try {
      const session = this.deps.authenticationSession(peer);
      if (typeof session === 'string' && session.length > 0) return session;
    } catch {
      // Native errors must not carry credential diagnostics into invoke replies.
    }
    throw new Error('DESKTOP_AUTHENTICATION_REQUIRED');
  }
  private authenticationCurrent(peer: string, session: string | undefined): boolean {
    try {
      return this.authenticationSession(peer) === session;
    } catch {
      // A failing native provider must revoke existing access, not preserve it.
      return false;
    }
  }
  tick(): void {
    if (
      this.active &&
      (this.active.expires <= this.now() ||
        !this.deps.authorized(this.active.peer) ||
        !this.authenticationCurrent(this.active.peer, this.active.authenticationSession))
    )
      this.stop();
  }
  /** Losing the signaling socket is expected while the phone shows PiP.
   * Only an authorized, view-only presentation may outlive it, and only while
   * the media channel keeps renewing the existing bounded lease. */
  signalingLost(peer?: string): void {
    this.tick();
    const active = this.active;
    if (active && (!peer || active.peer === peer) && active.backgroundViewing && !active.controlling)
      return;
    this.stop(peer);
  }
  stop(peer?: string): Promise<void> {
    if (peer && this.active?.peer !== peer) {
      // Cancelling a takeover candidate must not revoke the current owner's work.
      if (this.startingPeer === peer) this.startingPeer = null;
      return Promise.resolve();
    }
    this.lockAbort?.abort();
    if (this.active) this.lastEnded = { peer: this.active.peer, lease: this.active.lease };
    this.clipboardTransfer.reset();
    this.controlGeneration++;
    const restoring = this.clearSafety().catch(() =>
      log.warn('Safety restoration failed after stop'),
    );
    this.active = null;
    this.deps.stopInput();
    this.deps.stopVideo();
    this.viewerDisplay?.dispose();
    // Retain the handle until restoration completes (or can be retried after failure).
    // EOF releases it asynchronously; a new lease must not bind stale geometry.
    if (!this.viewerDisplay?.restore) this.viewerDisplay = null;
    if (this.viewerDisplay || this.originalResolution)
      void this.restoreStoppedDisplay().catch(() => {});
    this.viewerGeometryManaged = false;
    this.deps.changed();
    return restoring;
  }
  private async temporaryResolution(
    peer: string,
    active: NonNullable<RemoteDesktopController['active']>,
    modeId: string,
  ): Promise<RemoteDesktopLease> {
    if (!active.controlling) throw new Error('DESKTOP_VIEW_ONLY');
    if (!this.deps.resolution || !this.deps.displayModes)
      throw new Error('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
    if (this.inputStarting || this.clipboardPending || this.locking || this.starting)
      throw new Error('DESKTOP_DISPLAY_BUSY');
    const generation = this.controlGeneration;
    const current = () => {
      this.tick();
      return this.active === active && active.controlling && this.controlGeneration === generation;
    };
    const requireCurrent = () => {
      if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
    };
    this.displayChanging = true;
    try {
      this.deps.stopInput();
      this.deps.stopVideo();
      await this.clearSafety();
      requireCurrent();
      await this.deps.releaseInput?.();
      requireCurrent();
      // Remove the temporary mirror before enumerating the physical monitor.
      if (this.viewerDisplay) {
        if (!this.viewerDisplay.restore) throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
        await this.viewerDisplay.restore(current);
        requireCurrent();
        this.viewerDisplay = null;
      }
      const modes = await this.deps.displayModes(active.sourceDisplayId);
      requireCurrent();
      const original = modes.find((mode) => mode.current);
      const selected = modes.find((mode) => mode.id === modeId);
      if (!original || !selected) throw new Error('DESKTOP_DISPLAY_MODE_MISSING');
      this.originalResolution ??= {
        displayId: active.sourceDisplayId,
        modeId: original.id,
        width: original.width,
        height: original.height,
      };
      this.resolutionWrite = this.deps.resolution(
        active.sourceDisplayId,
        modeId,
        requireCurrent,
        selected,
      );
      await this.resolutionWrite;
      requireCurrent();
      active.display = {
        id: active.sourceDisplayId,
        name: active.display.name,
        width: selected.width,
        height: selected.height,
      };
      this.viewerGeometryManaged = true;
      active.controlling = false;
      this.controlGeneration++;
      this.deps.changed();
      return { lease: active.lease, display: active.display, controlling: false };
    } catch (error) {
      if (this.active === active) this.stop(peer);
      throw error;
    } finally {
      this.resolutionWrite = null;
      this.displayChanging = false;
    }
  }
  private restoreStoppedDisplay(): Promise<void> {
    if (this.displayRestoring) return this.displayRestoring;
    if (this.active || (!this.viewerDisplay && !this.originalResolution)) return Promise.resolve();
    const handle = this.viewerDisplay;
    const pending = (async () => {
      // A disconnect can arrive while the native write is still in flight.
      if (this.resolutionWrite) await this.resolutionWrite.catch(() => {});
      await handle?.restore?.(() => !this.active && this.viewerDisplay === handle);
      if (this.viewerDisplay === handle) this.viewerDisplay = null;
      const original = this.originalResolution;
      if (original) {
        if ((await this.deps.displayPresent?.(original.displayId)) !== false)
          await (this.deps.restoreResolution ?? this.deps.resolution)!(
            original.displayId,
            original.modeId,
            () => {
              if (this.active || this.originalResolution !== original)
                throw new Error('DESKTOP_LEASE_EXPIRED');
            },
            original,
          );
        if (this.originalResolution === original) this.originalResolution = null;
      }
    })();
    this.displayRestoring = pending;
    void pending
      .finally(() => {
        if (this.displayRestoring === pending) this.displayRestoring = null;
      })
      .catch(() => {});
    return pending;
  }
  /** Join the same restoration used by disconnects before the process exits. */
  async stopAndRestore(): Promise<void> {
    const safety = this.stop();
    await Promise.all([safety, this.restoreStoppedDisplay()]);
  }
  /**
   * Input injection failed while the lease is still valid. Input belongs to the
   * control bit, so release control and keep everything else: ending the lease
   * here would tear down capture and media, and every phone tap would surface as
   * a reconnect even though the desktop session itself is healthy. The viewer
   * observes the new state on its next heartbeat or input attempt. A pending
   * start is also cancelled so a failed helper cannot restore control later.
   */
  releaseControl(): void {
    const active = this.active;
    if (!active || (!active.controlling && !this.inputStarting)) return;
    void this.revokeControl().catch(() => log.warn('Safety restoration failed after control loss'));
  }
  /** Explicit local disconnect must not be undone by the phone's recovery. */
  stopByUser(): void {
    const target = this.active ?? this.lastEnded;
    if (target) this.userStopped.set(target.peer, target.lease);
    this.stop();
  }
  async stopPrivacyByUser(): Promise<void> {
    const active = this.active;
    if (!active?.privacyLockOnExit) {
      this.stopByUser();
      return;
    }
    // Enter the existing lock/stop path before marking the lease stopped:
    // subsequent phone input and recovery must be rejected while locking.
    const ending = this.request(active.peer, { op: 'stop', lease: active.lease, lockScreen: true });
    this.userStopped.set(active.peer, active.lease);
    try {
      await ending;
    } finally {
      if (this.active === active) this.stop(active.peer);
    }
  }
  private require(peer: string, lease: string) {
    this.tick();
    if (this.userStopped.get(peer) === lease) throw new Error('DESKTOP_STOPPED');
    const active = this.active;
    if (!active || active.peer !== peer || active.lease !== lease)
      throw new Error('DESKTOP_LEASE_EXPIRED');
    return active;
  }
  /** Only the trusted capture renderer may forward live DataChannel pongs. */
  viewHeartbeat(lease: string): void {
    this.tick();
    if (this.active?.lease === lease && this.active.backgroundViewing && !this.active.controlling)
      this.active.expires = this.now() + REMOTE_DESKTOP_LEASE_MS;
  }
  /** Also used by the exact capture renderer's DataChannel bridge. */
  input(lease: string, sequence: number, events: unknown): void {
    const active = this.active;
    if (!active)
      throw new Error(
        [...this.userStopped.values()].includes(lease)
          ? 'DESKTOP_STOPPED'
          : 'DESKTOP_LEASE_EXPIRED',
      );
    const request = parseRemoteDesktopRequest({ op: 'input', lease, sequence, events });
    if (request.op !== 'input') return;
    this.require(active.peer, lease);
    if (this.displayChanging) return; // Discard queued old-geometry input after authenticating it.
    if (!active.controlling) throw new Error('DESKTOP_VIEW_ONLY');
    if (sequence <= active.sequence) return; // never replay a click after retries/reconnect
    active.sequence = sequence;
    this.deps.input(request.events);
  }
  async request(peer: string, raw: unknown): Promise<unknown> {
    const request = parseRemoteDesktopRequest(raw);
    this.tick();
    if (request.op === 'capabilities') {
      // Protected hosts use a separate, minimal pre-auth handshake. The normal
      // capabilities response includes display information and is post-auth.
      const session = this.authenticationSession(peer);
      if (session !== undefined && !this.deps.authorized(peer)) throw new Error('DESKTOP_DISABLED');
      const viewerDisplay = this.viewerDisplay;
      const caps = await this.deps.capabilities();
      if (!this.authenticationCurrent(peer, session))
        throw new Error('DESKTOP_AUTHENTICATION_REQUIRED');
      if (session !== undefined && !this.deps.authorized(peer)) throw new Error('DESKTOP_DISABLED');
      // Keep the handle alive across the read: stop clears the lease before the
      // helper disappears, and restoration can settle while capabilities awaits.
      const publicDisplays = caps.displays.filter(
        (display) =>
          display.id !== viewerDisplay?.displayId && display.id !== this.viewerDisplay?.displayId,
      );
      return {
        ...caps,
        displays: publicDisplays,
        automaticReconnect: true,
        connectionTakeover: true,
        resolutionRestore: Boolean(
          caps.displayModes && this.deps.resolution && this.deps.displayModes,
        ),
      };
    }
    if (!this.deps.authorized(peer)) throw new Error('DESKTOP_DISABLED');
    if (request.op === 'permissions') {
      const session = this.authenticationSession(peer);
      if (!this.deps.permissions) throw new Error('DESKTOP_PERMISSIONS_UNAVAILABLE');
      const permissions = await this.deps.permissions(request.action);
      if (!this.authenticationCurrent(peer, session))
        throw new Error('DESKTOP_AUTHENTICATION_REQUIRED');
      return permissions;
    }
    if (request.op === 'start') {
      const authenticationSession = this.authenticationSession(peer);
      if (request.resume && this.userStopped.has(peer)) throw new Error('DESKTOP_STOPPED');
      const resumesActive =
        request.resume &&
        this.active?.peer === peer &&
        this.active.sourceDisplayId === request.displayId;
      if (
        this.locking ||
        this.starting ||
        this.displayChanging ||
        (this.active && !request.takeover && !resumesActive)
      )
        throw new Error('DESKTOP_BUSY');
      this.starting = true;
      this.startingPeer = peer;
      const generation = this.controlGeneration;
      try {
        if (!this.active && (this.viewerDisplay || this.originalResolution))
          await this.restoreStoppedDisplay();
        if (!this.active && this.deps.prepare) {
          const current = () =>
            this.startingPeer === peer &&
            generation === this.controlGeneration &&
            this.deps.authorized(peer) &&
            this.authenticationCurrent(peer, authenticationSession);
          if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
          await this.deps.prepare(current);
          if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
        }
        const caps = await this.deps.capabilities();
        if (!this.authenticationCurrent(peer, authenticationSession))
          throw new Error('DESKTOP_AUTHENTICATION_REQUIRED');
        let display = caps.displays.find((d) => d.id === request.displayId);
        if (!display) throw new Error('DESKTOP_DISPLAY_MISSING');
        if (
          this.startingPeer !== peer ||
          generation !== this.controlGeneration ||
          !this.deps.authorized(peer)
        )
          throw new Error('DESKTOP_DISABLED');
        if (caps.permissions && !desktopPermissionReady(caps.permissions.screenRecording))
          throw new Error('DESKTOP_SCREEN_PERMISSION_REQUIRED');
        if (request.resume && this.userStopped.has(peer)) throw new Error('DESKTOP_STOPPED');
        if (request.takeover && this.active) this.stopByUser();
        // A lost start reply can leave our own lease alive. Rotate it using the
        // existing cleanup so the new viewer can restart its input sequence at 0.
        else if (resumesActive) this.stop(peer);
        if (this.viewerDisplay || this.originalResolution) {
          const restorationGeneration = this.controlGeneration;
          await this.restoreStoppedDisplay();
          const restored = await this.deps.capabilities();
          if (
            this.startingPeer !== peer ||
            restorationGeneration !== this.controlGeneration ||
            !this.deps.authorized(peer) ||
            !this.authenticationCurrent(peer, authenticationSession)
          )
            throw new Error('DESKTOP_LEASE_EXPIRED');
          display = restored.displays.find((d) => d.id === request.displayId);
          if (!display) throw new Error('DESKTOP_DISPLAY_MISSING');
        }
        if (!request.resume) this.userStopped.delete(peer);
        const lease: RemoteDesktopLease = { lease: randomUUID(), display, controlling: false };
        this.active = {
          ...lease,
          peer,
          sourceDisplayId: display.id,
          expires: this.now() + REMOTE_DESKTOP_LEASE_MS,
          sequence: -1,
          authenticationSession,
        };
        this.deps.changed();
        return lease;
      } finally {
        this.starting = false;
        this.startingPeer = null;
      }
    }
    const active = this.require(peer, request.lease);
    if (this.displayChanging && !['stop', 'heartbeat', 'frame', 'input'].includes(request.op))
      throw new Error('DESKTOP_DISPLAY_BUSY');
    switch (request.op) {
      case 'windowAction': {
        if (!active.controlling) throw new Error('DESKTOP_VIEW_ONLY');
        if (!this.deps.windowAction) throw new Error('DESKTOP_INPUT_UNSUPPORTED');
        const generation = this.controlGeneration;
        const current = () => {
          this.tick();
          return (
            this.active === active && active.controlling && this.controlGeneration === generation
          );
        };
        const result = await this.deps.windowAction(
          request.action,
          request.action === 'activate' ? request.id : undefined,
          active.display.id,
          current,
        );
        if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
        return result;
      }
      case 'privacyScreen': {
        if (!active.controlling) throw new Error('DESKTOP_VIEW_ONLY');
        if (!this.deps.privacyScreen) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
        active.privacyLockOnExit = request.lockOnExit === true;
        // Lock preference changes join the same mask/capture initialization.
        if (this.privacyOperation?.enabled === request.enabled)
          return this.privacyOperation.promise;
        const generation = ++this.privacyGeneration;
        const current = () => {
          this.tick();
          return (
            this.active === active && active.controlling && generation === this.privacyGeneration
          );
        };
        const promise = this.deps
          .privacyScreen(request.enabled, current)
          .then(() => {
            if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
            return { enabled: request.enabled };
          })
          .catch((error) => {
            if (generation === this.privacyGeneration) this.privacyOperation = null;
            throw error;
          });
        this.privacyOperation = { enabled: request.enabled, promise };
        return promise;
      }
      case 'clipboardSync': {
        if (request.enabled && (!active.controlling || !this.deps.clipboardVersion))
          throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
        if (active.clipboardSync !== request.enabled) {
          this.syncGeneration++;
          this.clipboardTransfer.resetSync();
        }
        active.clipboardSync = request.enabled;
        return { enabled: request.enabled };
      }
      case 'hostMute': {
        if (!active.controlling) throw new Error('DESKTOP_VIEW_ONLY');
        if (!this.deps.hostMute) throw new Error('DESKTOP_HOST_MUTE_UNAVAILABLE');
        active.hostMute = request.enabled;
        await this.deps.hostMute(request.enabled);
        return { enabled: request.enabled };
      }
      case 'clipboardVersion': {
        if (!active.controlling || !active.clipboardSync || !this.deps.clipboardVersion)
          throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
        const generation = this.syncGeneration;
        const version = await this.deps.clipboardVersion();
        this.require(peer, request.lease);
        if (!active.controlling || !active.clipboardSync || generation !== this.syncGeneration)
          throw new Error('DESKTOP_LEASE_EXPIRED');
        return { version };
      }
      case 'restoreViewerDisplay':
      case 'viewerDisplay': {
        if (!active.controlling) throw new Error('DESKTOP_VIEW_ONLY');
        if (this.inputStarting || this.clipboardPending || this.locking || this.starting)
          throw new Error('DESKTOP_DISPLAY_BUSY');
        if (!this.deps.createViewerDisplay) throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
        const generation = this.controlGeneration;
        const current = () => {
          this.tick();
          return (
            this.active === active && generation === this.controlGeneration && active.controlling
          );
        };
        this.displayChanging = true;
        try {
          // Wait for held keys/buttons to be released in the old coordinate space.
          this.deps.stopInput();
          this.deps.stopVideo();
          // Safety effects belong to the old capture/control session, even though
          // resizing retains its lease. Invalidate pending enables before waiting.
          await this.clearSafety();
          if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
          if (this.deps.releaseInput) await this.deps.releaseInput();
          if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
          if (request.op === 'restoreViewerDisplay' && !this.viewerDisplay?.restore)
            throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
          if (!this.viewerDisplay) {
            const handle = await this.deps.createViewerDisplay(active.display.id, current, () => {
              if (this.active === active) this.stop(peer);
            });
            if (!current()) {
              handle.dispose();
              throw new Error('DESKTOP_LEASE_EXPIRED');
            }
            this.viewerDisplay = handle;
          }
          let display =
            request.op === 'restoreViewerDisplay'
              ? await this.viewerDisplay.restore!(current)
              : await this.viewerDisplay.resize(request.width, request.height, current);
          if (
            request.op === 'restoreViewerDisplay' &&
            !(await this.deps.capabilities()).displays.some(
              (item) => item.id === active.sourceDisplayId,
            )
          )
            throw new Error('DESKTOP_DISPLAY_MISSING');
          if (request.op === 'restoreViewerDisplay') {
            this.viewerDisplay = null;
            const original = this.originalResolution;
            if (original) {
              this.resolutionWrite = (this.deps.restoreResolution ?? this.deps.resolution)!(
                original.displayId,
                original.modeId,
                () => {
                  if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
                },
                original,
              );
              await this.resolutionWrite;
              if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
              this.originalResolution = null;
              display = { ...display, width: original.width, height: original.height };
            }
          }
          if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
          this.viewerGeometryManaged = true;
          active.display = display;
          active.controlling = false;
          this.controlGeneration++;
          this.deps.changed();
          return { lease: active.lease, display, controlling: false };
        } catch (error) {
          if (this.active === active) this.stop(peer);
          throw error;
        } finally {
          this.resolutionWrite = null;
          this.displayChanging = false;
        }
      }
      case 'stop': {
        if (request.lockScreen) {
          if (!this.deps.lockScreen) throw new Error('DESKTOP_LOCK_UNAVAILABLE');
          if (this.locking || this.starting) throw new Error('DESKTOP_BUSY');
          this.locking = true;
          const cancellation = new AbortController();
          this.lockAbort = cancellation;
          active.controlling = false;
          this.controlGeneration++;
          try {
            await this.deps.lockScreen(() => {
              this.tick();
              return this.active === active && this.deps.authorized(peer);
            }, cancellation.signal);
          } finally {
            this.lockAbort = null;
            this.locking = false;
            if (this.active === active) this.stop(peer);
          }
          return { ok: true };
        }
        this.stop(peer);
        return { ok: true };
      }
      case 'heartbeat':
        active.expires = this.now() + REMOTE_DESKTOP_LEASE_MS;
        return { controlling: active.controlling };
      case 'presentation': {
        active.backgroundViewing = request.enabled;
        if (request.enabled) {
          await this.revokeControl();
        } else {
          this.deps.changed();
        }
        return { controlling: active.controlling };
      }
      case 'control': {
        if (this.locking) throw new Error('DESKTOP_BUSY');
        if (request.enabled) active.backgroundViewing = false;
        if (request.enabled && this.inputStarting) throw new Error('DESKTOP_INPUT_BUSY');
        if (!request.enabled) {
          await this.revokeControl();
          return { controlling: active.controlling };
        }
        this.clipboardTransfer.reset();
        const generation = ++this.controlGeneration;
        if (!active.controlling) {
          this.inputStarting = true;
          try {
            await this.deps.startInput(active.display.id);
            if (
              generation !== this.controlGeneration ||
              this.active !== active ||
              !this.deps.authorized(peer)
            ) {
              this.deps.stopInput();
              throw new Error(
                this.userStopped.get(peer) === request.lease
                  ? 'DESKTOP_STOPPED'
                  : 'DESKTOP_LEASE_EXPIRED',
              );
            }
            this.require(peer, request.lease);
            active.controlling = true;
          } finally {
            this.inputStarting = false;
          }
        }
        this.deps.changed();
        return { controlling: active.controlling };
      }
      case 'clipboardContent':
      case 'clipboard': {
        if (!active.controlling) throw new Error('DESKTOP_VIEW_ONLY');
        if (request.op === 'clipboardContent' && request.sync && !active.clipboardSync)
          throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
        if (request.op === 'clipboard' ? !this.deps.clipboard : !this.deps.clipboardContent)
          throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
        if (this.clipboardPending) throw new Error('DESKTOP_CLIPBOARD_BUSY');
        const generation = this.controlGeneration;
        const syncGeneration = this.syncGeneration;
        const isCurrent = () => {
          this.tick();
          return (
            this.active === active &&
            active.controlling &&
            generation === this.controlGeneration &&
            !(
              request.op === 'clipboardContent' &&
              request.sync &&
              (!active.clipboardSync || syncGeneration !== this.syncGeneration)
            )
          );
        };
        this.clipboardPending = true;
        try {
          if (request.op === 'clipboardContent') {
            const result = await this.clipboardTransfer.handle(
              request,
              isCurrent,
              this.deps.clipboardContent!,
            );
            if (!isCurrent()) {
              this.clipboardTransfer.reset();
              throw new Error('DESKTOP_LEASE_EXPIRED');
            }
            return result;
          }
          const text = await this.deps.clipboard!(
            request.action,
            request.action === 'paste' ? request.text : undefined,
            isCurrent,
          );
          this.require(peer, request.lease);
          if (!isCurrent()) throw new Error('DESKTOP_VIEW_ONLY');
          return request.action === 'copy' ? { text } : { ok: true };
        } finally {
          this.clipboardPending = false;
        }
      }
      case 'input':
        this.input(request.lease, request.sequence, request.events);
        return { ok: true };
      case 'frame': {
        if (this.displayChanging) return { jpeg: null };
        const display = active.display;
        // Compatibility transport: one small frame in flight, no replaying frame queue.
        if (this.framePending || this.now() - this.lastFrame < 250) return { jpeg: null };
        this.framePending = true;
        this.lastFrame = this.now();
        try {
          const jpeg = await this.deps.frame(
            active.display.id,
            request.cursorOverlay,
            active.lease,
          );
          this.require(peer, request.lease); // revoke during capture must not leak the result
          if (this.displayChanging || active.display !== display) return { jpeg: null };
          const frame = typeof jpeg === 'object' && jpeg !== null ? jpeg : { jpeg };
          // Cursor metadata does not turn a relay frame into a local media frame.
          if (frame.jpeg && frame.jpeg.length > Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4)
            return { jpeg: null };
          return frame;
        } finally {
          this.framePending = false;
        }
      }
      case 'displayModes': {
        if (!this.deps.displayModes) throw new Error('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
        // The virtual capture display has only its current mode. System mode IDs
        // belong to the monitor selected when this lease began.
        const modes = await this.deps.displayModes(active.sourceDisplayId);
        this.require(peer, request.lease);
        return modes;
      }
      case 'resolution': {
        if (request.temporary) return this.temporaryResolution(peer, active, request.modeId);
        if (!active.controlling) throw new Error('DESKTOP_VIEW_ONLY');
        if (!this.deps.resolution) throw new Error('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
        if (this.inputStarting || this.clipboardPending || this.locking || this.starting)
          throw new Error('DESKTOP_DISPLAY_BUSY');
        const restoringViewer = this.viewerDisplay !== null;
        const generation = this.controlGeneration;
        const current = () => {
          this.tick();
          return (
            this.active === active && active.controlling && generation === this.controlGeneration
          );
        };
        const beforeChange = () => {
          if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
          // Release old geometry before the native write can emit display events.
          // Completion must not inspect or stop a replacement lease.
          this.stop(peer);
        };
        try {
          if (this.viewerDisplay) {
            this.displayChanging = true;
            try {
              this.deps.stopInput();
              this.deps.stopVideo();
              if (this.deps.releaseInput) await this.deps.releaseInput();
              if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
              if (!this.viewerDisplay.restore)
                throw new Error('DESKTOP_VIEWER_DISPLAY_UNAVAILABLE');
              // Finish the helper's original-mode write before applying a system
              // mode; otherwise delayed cleanup can overwrite the user's choice.
              const restored = await this.viewerDisplay.restore(current);
              if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
              if (restored.width <= 0 || restored.height <= 0)
                throw new Error('DESKTOP_DISPLAY_MISSING');
              const restoredCaps = await this.deps.capabilities();
              if (!restoredCaps.displays.some((display) => display.id === active.sourceDisplayId))
                throw new Error('DESKTOP_DISPLAY_MISSING');
              this.viewerDisplay = null;
              active.display = restored;
            } finally {
              this.displayChanging = false;
            }
          }
          await this.deps.resolution(active.sourceDisplayId, request.modeId, beforeChange);
          return { ok: true };
        } catch (error) {
          if (restoringViewer && current()) this.stop(peer);
          throw error;
        }
      }
      case 'offer': {
        const sdp = await this.deps.offer(
          active,
          request.sdp,
          request.settings,
          request.cursorOverlay,
          request.attemptId,
        );
        this.require(peer, request.lease);
        return { sdp };
      }
      case 'ice': {
        if (!this.deps.ice) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
        const result = await this.deps.ice(request);
        this.require(peer, request.lease);
        return result;
      }
    }
  }
}
