import type {
  VoiceCallCommand,
  VoiceCallStatus,
  VoiceCallStatusUpdate,
} from '../../shared/voiceConversation.js';

const COMMAND_CHANNEL = 'voice-conversation:call-command';
const STATUS_CHANNEL = 'voice-conversation:call-status-changed';
/** Longest an accepted start may go without any reaction from the host. */
const START_REACTION_MS = 10_000;

/**
 * Who holds the one voice line. Main alone writes it, so every window and the host
 * agree on it:
 * - free: nothing accepted or live
 * - starting: a start was handed to the host and nothing came back yet
 * - acked: the host is bringing the call up (it published a not-yet-open frame)
 * - open: the call is live
 * A start is accepted only from `free`. The line is released by the host publishing
 * null or closing the call, by the host window going away, or by the host never
 * reacting within START_REACTION_MS.
 */
type Line = 'free' | 'starting' | 'acked' | 'open';

type Deps = {
  hostSender(): number | null;
  send(sender: number, channel: string, payload: unknown): void;
  onActiveChange(active: boolean): void;
};

/**
 * Relays one call between the windows. Capture and playback stay in the main window, so
 * other windows only read this status and forward operations. Only windows that asked for
 * the status receive it, which keeps transcripts out of plugin and utility windows.
 */
export class VoiceCallCoordinator {
  private deps: Deps | null = null;
  private status: VoiceCallStatus | null = null;
  private line: Line = 'free';
  private reaction: ReturnType<typeof setTimeout> | null = null;
  /** The host window may already be gone when its destruction is reported. */
  private lastHost: number | null = null;
  /** The host has subscribed to commands; false while it boots or reloads. */
  private hostReady = false;
  private readonly subscribers = new Set<number>();

  configure(deps: Deps): void {
    this.deps = deps;
  }

  subscribe(sender: number): VoiceCallStatus | null {
    this.subscribers.add(sender);
    return this.status;
  }

  publish(sender: number, update: VoiceCallStatusUpdate): void {
    if (sender !== this.deps?.hostSender()) return;
    this.lastHost = sender;
    if ('ready' in update) {
      this.hostReady = update.ready;
      if (!update.ready) this.release();
      return;
    }
    this.apply(update, sender);
  }

  command(command: VoiceCallCommand): boolean {
    const host = this.deps?.hostSender() ?? null;
    // A command sent before the host listens would vanish while looking accepted.
    if (host === null || !this.hostReady) return false;
    // The call in progress keeps the line; a second one never replaces it.
    if (command.type === 'start') {
      if (this.line !== 'free') return false;
      // Hold the line now: the host only publishes after it renders, and a second
      // window could otherwise be told it got the line in that gap.
      this.line = 'starting';
      this.reaction = setTimeout(() => {
        if (this.line === 'starting') this.release();
      }, START_REACTION_MS);
    }
    this.deps?.send(host, COMMAND_CHANNEL, command);
    return true;
  }

  windowGone(sender: number): void {
    this.subscribers.delete(sender);
    if (sender !== this.deps?.hostSender() && sender !== this.lastHost) return;
    this.lastHost = null;
    this.hostReady = false;
    this.release();
    if (this.status) this.apply({ status: null }, sender);
  }

  private release(): void {
    if (this.reaction) clearTimeout(this.reaction);
    this.reaction = null;
    this.line = 'free';
  }

  /** The only place a host frame moves the line. */
  private follow(update: VoiceCallStatusUpdate): void {
    if (!('status' in update)) return; // audio levels say nothing about the line
    if (update.status === null) {
      this.release();
    } else if (update.status.open) {
      if (this.reaction) clearTimeout(this.reaction);
      this.reaction = null;
      this.line = 'open';
    } else if (this.line === 'open') {
      this.release(); // the live call is closing: a new start may take the line
    } else if (this.line === 'starting') {
      if (this.reaction) clearTimeout(this.reaction);
      this.reaction = null;
      this.line = 'acked'; // the host is bringing it up; keep holding the line
    }
  }

  private apply(update: VoiceCallStatusUpdate, sender: number): void {
    this.follow(update);
    const wasActive = this.status?.open ?? false;
    if ('ready' in update) return;
    if ('status' in update) this.status = update.status;
    else if (this.status)
      this.status = { ...this.status, state: { ...this.status.state, level: update.level } };
    else return;
    for (const subscriber of this.subscribers)
      if (subscriber !== sender) this.deps?.send(subscriber, STATUS_CHANNEL, update);
    const active = this.status?.open ?? false;
    if (active !== wasActive) this.deps?.onActiveChange(active);
  }
}

export const voiceCallCoordinator = new VoiceCallCoordinator();
