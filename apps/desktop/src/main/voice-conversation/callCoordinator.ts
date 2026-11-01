import type {
  VoiceCallCommand,
  VoiceCallStatus,
  VoiceCallStatusUpdate,
} from '../../shared/voiceConversation.js';

const COMMAND_CHANNEL = 'voice-conversation:call-command';
const STATUS_CHANNEL = 'voice-conversation:call-status-changed';
/** Longest a start may stay unconfirmed, e.g. when the host rejects it without a status. */
const START_RESERVATION_MS = 10_000;

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
  /** A start already accepted whose first status has not arrived yet. */
  private starting: ReturnType<typeof setTimeout> | null = null;
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
      if (this.status?.open || this.starting) return false;
      // Reserve now: the host only publishes after it renders, and a second window
      // could otherwise be told it got the line in that gap.
      this.starting = setTimeout(() => (this.starting = null), START_RESERVATION_MS);
    }
    this.deps?.send(host, COMMAND_CHANNEL, command);
    return true;
  }

  windowGone(sender: number): void {
    this.subscribers.delete(sender);
    if (sender !== this.deps?.hostSender() && sender !== this.lastHost) return;
    this.lastHost = null;
    this.hostReady = false;
    this.clearStarting();
    if (this.status) this.apply({ status: null }, sender);
  }

  private clearStarting(): void {
    if (this.starting) clearTimeout(this.starting);
    this.starting = null;
  }

  private apply(update: VoiceCallStatusUpdate, sender: number): void {
    this.clearStarting();
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
