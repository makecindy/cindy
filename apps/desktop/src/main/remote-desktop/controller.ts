import { ClipboardTransfer } from './clipboardTransfer';
import { randomUUID } from 'node:crypto';
import {
  parseRemoteDesktopRequest,
  REMOTE_DESKTOP_LEASE_MS,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  type DesktopInput,
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

export interface DesktopControllerDeps {
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
  ): Promise<string | RemoteDesktopCursorFrame | null>;
  startInput(displayId: string): Promise<void>;
  input(events: DesktopInput[]): void;
  stopInput(): void;
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
  resolution?(displayId: string, modeId: string, beforeChange: () => void): Promise<void>;
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
  stopHostMute?(): void;
  changed(): void;
  now?: () => number;
}

/** One human lease, peer-bound, with finite lifetime even if the relay disappears. */
export class RemoteDesktopController {
  private active:
    | (RemoteDesktopLease & {
        peer: string;
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
  private locking = false;
  private lockAbort: AbortController | null = null;
  private startingPeer: string | null = null;
  private framePending = false;
  private clipboardPending = false;
  private syncGeneration = 0;
  private privacyGeneration = 0;
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
  stop(peer?: string): void {
    if (peer && this.active?.peer !== peer) {
      // Cancelling a takeover candidate must not revoke the current owner's work.
      if (this.startingPeer === peer) this.startingPeer = null;
      return;
    }
    this.lockAbort?.abort();
    if (this.active) this.lastEnded = { peer: this.active.peer, lease: this.active.lease };
    this.clipboardTransfer.reset();
    this.controlGeneration++;
    this.active = null;
    this.deps.stopPrivacyScreen?.();
    this.deps.stopHostMute?.();
    this.deps.stopInput();
    this.deps.stopVideo();
    this.deps.changed();
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
    active.controlling = false;
    this.controlGeneration++;
    this.clipboardTransfer.reset();
    this.deps.stopInput();
    this.deps.changed();
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
      const caps = await this.deps.capabilities();
      if (!this.authenticationCurrent(peer, session))
        throw new Error('DESKTOP_AUTHENTICATION_REQUIRED');
      if (session !== undefined && !this.deps.authorized(peer)) throw new Error('DESKTOP_DISABLED');
      return { ...caps, automaticReconnect: true, connectionTakeover: true };
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
        this.active.display.id === request.displayId;
      if (this.locking || this.starting || (this.active && !request.takeover && !resumesActive))
        throw new Error('DESKTOP_BUSY');
      this.starting = true;
      this.startingPeer = peer;
      const generation = this.controlGeneration;
      try {
        const caps = await this.deps.capabilities();
        if (!this.authenticationCurrent(peer, authenticationSession))
          throw new Error('DESKTOP_AUTHENTICATION_REQUIRED');
        const display = caps.displays.find((d) => d.id === request.displayId);
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
        if (!request.resume) this.userStopped.delete(peer);
        const lease: RemoteDesktopLease = { lease: randomUUID(), display, controlling: false };
        this.active = {
          ...lease,
          peer,
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
    switch (request.op) {
      case 'privacyScreen': {
        if (!this.deps.privacyScreen) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
        active.privacyLockOnExit = request.lockOnExit === true;
        const generation = ++this.privacyGeneration;
        await this.deps.privacyScreen(request.enabled, () => {
          this.tick();
          return this.active === active && generation === this.privacyGeneration;
        });
        this.require(peer, request.lease);
        if (generation !== this.privacyGeneration) throw new Error('DESKTOP_LEASE_EXPIRED');
        return { enabled: request.enabled };
      }
      case 'clipboardSync': {
        if (request.enabled && (!active.controlling || !this.deps.clipboardVersion))
          throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
        this.syncGeneration++;
        active.clipboardSync = request.enabled;
        this.clipboardTransfer.reset();
        return { enabled: request.enabled };
      }
      case 'hostMute': {
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
          active.controlling = false;
          this.clipboardTransfer.reset();
          this.controlGeneration++;
          this.deps.stopInput();
        }
        this.deps.changed();
        return { controlling: active.controlling };
      }
      case 'control': {
        if (this.locking) throw new Error('DESKTOP_BUSY');
        if (request.enabled) active.backgroundViewing = false;
        if (request.enabled && this.inputStarting) throw new Error('DESKTOP_INPUT_BUSY');
        this.clipboardTransfer.reset();
        const generation = ++this.controlGeneration;
        if (!request.enabled) {
          active.controlling = false;
          this.deps.stopInput();
        } else if (!active.controlling) {
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
        // Compatibility transport: one small frame in flight, no replaying frame queue.
        if (this.framePending || this.now() - this.lastFrame < 250) return { jpeg: null };
        this.framePending = true;
        this.lastFrame = this.now();
        try {
          const jpeg = await this.deps.frame(active.display.id, request.cursorOverlay);
          this.require(peer, request.lease); // revoke during capture must not leak the result
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
        const modes = await this.deps.displayModes(active.display.id);
        this.require(peer, request.lease);
        return modes;
      }
      case 'resolution': {
        if (!active.controlling) throw new Error('DESKTOP_VIEW_ONLY');
        if (!this.deps.resolution) throw new Error('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
        const generation = this.controlGeneration;
        const beforeChange = () => {
          this.tick();
          if (
            this.active !== active ||
            !active.controlling ||
            generation !== this.controlGeneration
          )
            throw new Error('DESKTOP_LEASE_EXPIRED');
          // Release old geometry before the native write can emit display events.
          // Completion must not inspect or stop a replacement lease.
          this.stop(peer);
        };
        await this.deps.resolution(active.display.id, request.modeId, beforeChange);
        return { ok: true };
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
