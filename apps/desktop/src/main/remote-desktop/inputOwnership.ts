import type { DesktopInput } from '@cindy/device-link';

// Coordinate actual input, not the lifetime of a remote desktop connection.
const humans = new Set<HumanDesktopInput>();
const actions = new Set<Promise<void>>();
let revision = 0;
export const HUMAN_INPUT_QUIET_MS = 300;
export const desktopInputRevision = (): number => revision;
export const hasRemoteDesktopInput = (): boolean => humans.size > 0;
export const isHumanDesktopInputActive = (): boolean => [...humans].some((human) => human.busy);

/** Tracks queued native input and held gestures for one input-helper generation. */
export class HumanDesktopInput {
  private held = new Set<string>();
  private pending = 0;
  private quietUntil = 0;
  private released = false;
  private stopping = false;

  constructor() {
    humans.add(this);
  }

  get busy(): boolean {
    return this.stopping || this.pending > 0 || this.held.size > 0 || Date.now() < this.quietUntil;
  }

  begin(events: DesktopInput[]): { ready: Promise<void>; complete: () => void } {
    if (this.released) throw new Error('DESKTOP_LEASE_EXPIRED');
    revision++;
    this.pending++;
    for (const event of events) {
      if (event.kind === 'release') this.held.clear();
      if (event.kind === 'key' || event.kind === 'button') {
        const id = event.kind === 'key' ? `key:${event.code}` : `button:${event.button}`;
        if (event.down) this.held.add(id);
        else this.held.delete(id);
      }
    }
    // Reserve human priority immediately. Let an already-dispatched primitive
    // finish before moving focus; the Agent yields before its next text chunk.
    const ready = Promise.all([...actions]).then(() => undefined);
    let completed = false;
    return {
      ready,
      complete: () => {
        if (completed) return;
        completed = true;
        this.pending--;
        this.quietUntil = Date.now() + HUMAN_INPUT_QUIET_MS;
      },
    };
  }

  holdUntilExit(): void {
    this.stopping = true;
  }

  // Called only after native release/exit, never merely when key-up is queued.
  release(): void {
    this.released = true;
    humans.delete(this);
  }
}

export async function withAgentDesktopInput<T>(
  run: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  if (isHumanDesktopInputActive()) {
    throw new Error(
      'Remote desktop input is active. Yield briefly, then get fresh window state before retrying; the remote connection can stay open.',
    );
  }
  if (actions.size > 0)
    throw new Error('DESKTOP_INPUT_BUSY: another Agent input action is finishing.');
  const startedAt = revision;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  actions.add(done);
  try {
    return await run(() => {
      if (revision !== startedAt) {
        throw new Error(
          'Remote desktop input arrived. Agent yielded before further input; previous input may have completed. Get fresh window state before continuing.',
        );
      }
    });
  } finally {
    actions.delete(done);
    finish();
  }
}
