import type { DesktopInput } from '@cindy/device-link';

// Coordinate actual input, not the lifetime of a remote desktop connection.
const humans = new Set<HumanDesktopInput>();
const actions = new Set<Promise<void>>();
const waiters: Array<() => void> = [];
let revision = 0;
let agentRevision = 0;
export const HUMAN_INPUT_QUIET_MS = 300;
export const AGENT_INPUT_WAIT_MS = 5_000;
export const desktopInputRevision = (): number => revision;
export const agentDesktopInputRevision = (): number => agentRevision;
export const isAgentDesktopInputActive = (): boolean => actions.size > 0;
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

function inputError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** FIFO admission for one logical input (including all of its text chunks). */
export function withAgentDesktopInput<T>(
  run: (assertCurrent: () => void) => Promise<T>,
  options: { signal?: AbortSignal; assertCurrent?: () => void } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      const index = waiters.indexOf(start);
      if (index >= 0) waiters.splice(index, 1);
    };
    const cancel = () => {
      remove();
      reject(inputError('REQUEST_CANCELLED', 'Computer Use cancelled while waiting; no input was dispatched.'));
    };
    const start = () => {
      remove();
      if (options.signal?.aborted) return cancel();
      void runOwnedInput(run, options.assertCurrent).then(resolve, reject);
    };
    if (options.signal?.aborted) return cancel();
    if (isHumanDesktopInputActive() || actions.size === 0) return start();
    waiters.push(start);
    options.signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      remove();
      reject(inputError('DESKTOP_INPUT_BUSY', 'Another Agent input is still finishing. No input was dispatched; get fresh window state before retrying.'));
    }, AGENT_INPUT_WAIT_MS);
  });
}

async function runOwnedInput<T>(
  run: (assertCurrent: () => void) => Promise<T>,
  validate?: () => void,
): Promise<T> {
  if (isHumanDesktopInputActive()) {
    throw inputError('DESKTOP_INPUT_BUSY',
      'Remote desktop input is active. Yield briefly, then get fresh window state before retrying; the remote connection can stay open.',
    );
  }
  // Validate after waiting, atomically with ownership acquisition.
  validate?.();
  const startedAt = revision;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  actions.add(done);
  agentRevision++;
  try {
    return await run(() => {
      if (revision !== startedAt) {
        throw inputError('DESKTOP_INPUT_YIELDED',
          'Remote desktop input arrived. Agent yielded before further input; previous input may have completed. Get fresh window state before continuing.',
        );
      }
    });
  } finally {
    actions.delete(done);
    finish();
    // A refused waiter does not own input; keep draining until one does.
    while (actions.size === 0 && waiters.length > 0) waiters.shift()!();
  }
}
