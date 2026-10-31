import type {
  VoiceCallCommand,
  VoiceCallStatus,
  VoiceCallStatusUpdate,
} from '../../shared/voiceConversation.js';

const COMMAND_CHANNEL = 'voice-conversation:call-command';
const STATUS_CHANNEL = 'voice-conversation:call-status-changed';

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
    this.apply(update, sender);
  }

  command(command: VoiceCallCommand): boolean {
    const host = this.deps?.hostSender() ?? null;
    if (host === null) return false;
    // The call in progress keeps the line; a second one never replaces it.
    if (command.type === 'start' && this.status?.open) return false;
    this.deps?.send(host, COMMAND_CHANNEL, command);
    return true;
  }

  windowGone(sender: number): void {
    this.subscribers.delete(sender);
    if (sender === this.deps?.hostSender() && this.status) this.apply({ status: null }, sender);
  }

  private apply(update: VoiceCallStatusUpdate, sender: number): void {
    const wasActive = this.status?.open ?? false;
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
