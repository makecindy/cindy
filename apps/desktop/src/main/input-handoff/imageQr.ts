import type {
  InputHandoffDecision,
  InputHandoffHolder,
  InputHandoffPhase,
  InputHandoffPicture,
  InputHandoffQr,
  InputHandoffSnapshot,
  InputHandoffSource,
  InputHandoffSubmission,
} from '@cindy/device-link';
import { classifyOrigin } from './originPolicy.js';
import type { HandoffEndReason, HandoffResult } from './session.js';

/**
 * 代输入 for a sign-in QR code the agent captured in a screenshot, for screens
 * that are not a window on this computer (a device simulator shown inside
 * Cindy, a remote screen). Cindy reads the code itself and shows the owner
 * where it leads; the agent's picture is labelled as such. Cindy cannot see
 * that screen, so it cannot tell when the sign-in finished: the owner hands
 * back, and the agent checks for itself.
 */

/** The code cut out of the agent's picture, with what it says. */
export interface PictureQr {
  jpeg: Buffer;
  width: number;
  height: number;
  qr: InputHandoffQr;
}

export interface ImageQrSessionOptions {
  requestId: string;
  purpose: string;
  note?: string;
  requester?: string;
  timeoutMs: number;
  remoteInput: boolean;
  picture: PictureQr;
  publish(snapshot: InputHandoffSnapshot): void;
  finish(result: HandoffResult): void;
}

function sameHolder(a: InputHandoffHolder, b: InputHandoffHolder): boolean {
  return a.local === true ? b.local === true : b.local !== true && a.deviceId === b.deviceId;
}

/** Where the code leads, from its own content: the site the owner would sign in to. */
export function pictureQrSource(qr: InputHandoffQr): InputHandoffSource {
  const { origin, warning } = qr.url ? classifyOrigin(qr.url, false) : {};
  return { app: 'Cindy', ...(origin ? { origin } : {}), ...(warning ? { warning } : {}) };
}

export class ImageQrHandoffSession {
  private revision = 0;
  private unheldClaimFrom: number | null = null;
  private phase: InputHandoffPhase = 'ready';
  private holder: InputHandoffHolder | undefined;
  private answeredOn: InputHandoffHolder | undefined;
  private failure: HandoffResult['failure'];
  private ended = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly source: InputHandoffSource;

  constructor(private readonly options: ImageQrSessionOptions) {
    this.source = pictureQrSource(options.picture.qr);
  }

  get requestId(): string {
    return this.options.requestId;
  }

  snapshot(): InputHandoffSnapshot {
    const ready = this.phase === 'ready' && !this.ended;
    return {
      kind: 'input_handoff',
      requestId: this.options.requestId,
      revision: this.revision,
      phase: this.phase,
      purpose: this.options.purpose,
      ...(this.options.note ? { note: this.options.note } : {}),
      ...(this.holder ? { holder: { ...this.holder } } : {}),
      ...(this.options.requester ? { requester: this.options.requester } : {}),
      source: this.source,
      stepNumber: 1,
      controls: [],
      ...(this.failure ? { failure: this.failure } : {}),
      // Older clients show their "the agent opened this" caution for it.
      agentControlled: true,
      agentPicture: true,
      ...(this.options.remoteInput && !this.ended ? { remoteInput: true as const } : {}),
      ...(this.ended ? { terminal: true as const } : {}),
      ...(ready ? { picture: true as const, qr: 'scan' as const } : {}),
    };
  }

  isActionable(revision: number): boolean {
    return !this.ended && this.phase === 'ready' && this.acceptsRevision(revision);
  }

  /** The current revision, or the one just before a quiet claim moved it (see `decide`). */
  private acceptsRevision(revision: number): boolean {
    return revision === this.revision || (this.unheldClaimFrom !== null && revision === this.unheldClaimFrom && this.revision === revision + 1);
  }

  async start(): Promise<void> {
    this.publish('ready');
    this.expiryTimer = setTimeout(() => this.end('expired', 'timeout', 'timeout'), this.options.timeoutMs);
    this.expiryTimer.unref?.();
  }

  /** Nothing is typed on this step. */
  async submit(submission: InputHandoffSubmission): Promise<boolean> {
    for (const key of Object.keys(submission.values)) delete submission.values[key];
    return false;
  }

  async decide(decision: InputHandoffDecision, actor?: InputHandoffHolder): Promise<boolean> {
    // Like InputHandoffSession: decisions bind to the current revision only, so a
    // stale done/cancel/claim from before another device took over is refused.
    if (this.ended || decision.expectedRevision !== this.revision) return false;
    switch (decision.action) {
      case 'done':
        this.answeredOn = actor ?? { local: true };
        this.end('succeeded', 'owner');
        return true;
      case 'cancel':
        this.end('cancelled', 'cancelled');
        return true;
      case 'claim': {
        if (!actor) return false;
        if (this.holder && sameHolder(this.holder, actor)) return true;
        const unheld = this.holder ? null : this.revision;
        this.holder = actor;
        this.publish(this.phase);
        this.unheldClaimFrom = unheld;
        return true;
      }
      case 'refresh':
        this.publish(this.phase);
        return true;
      default:
        return false;
    }
  }

  cancel(reason: HandoffEndReason = 'cancelled'): void {
    this.end('cancelled', reason);
  }

  pictureFor(revision: number): InputHandoffPicture | null {
    if (!this.isActionable(revision)) return null;
    const { picture } = this.options;
    return {
      mime: 'image/jpeg',
      width: picture.width,
      height: picture.height,
      data: picture.jpeg.toString('base64'),
      qr: { ...picture.qr },
    };
  }

  private publish(phase: InputHandoffPhase): void {
    this.phase = phase;
    this.revision++;
    this.options.publish(this.snapshot());
  }

  private end(status: HandoffResult['status'], reason: HandoffEndReason, failure?: HandoffResult['failure']): void {
    if (this.ended) return;
    this.ended = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.failure = failure;
    this.options.picture.jpeg.fill(0);
    const phase: InputHandoffPhase = status === 'succeeded' ? 'succeeded' : status === 'expired' ? 'expired'
      : status === 'cancelled' ? 'cancelled' : 'failed';
    this.publish(phase);
    this.options.finish({
      status,
      reason,
      steps: status === 'succeeded' ? 1 : 0,
      scanned: true,
      ...(failure ? { failure } : {}),
      ...(this.source.origin ? { finalOrigin: this.source.origin } : {}),
      ...(this.answeredOn ? { answeredOn: { ...this.answeredOn } } : {}),
    });
  }
}
