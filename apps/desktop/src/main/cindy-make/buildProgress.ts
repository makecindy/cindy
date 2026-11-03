import { parseCindyMakeBuildOutput } from '../../shared/cindyMakeBuildDiagnostic.js';
import type { CindyMakePersonalBuildState } from '../../shared/cindyMakeSession.js';

/** Buffer complete lines so split credentials are scrubbed before the UI sees them. */
export function createMakeBuildLineOutput(onLine?: (line: string) => void) {
  let pending = '';
  let dropping = false;
  let lastLine: string | undefined;
  const finish = () => {
    const line = dropping ? undefined : parseCindyMakeBuildOutput(pending);
    pending = '';
    dropping = false;
    if (line && line !== lastLine) {
      lastLine = line;
      onLine?.(line);
    }
  };
  return {
    append(chunk: string) {
      if (!onLine) return;
      const parts = chunk.split(/[\r\n]/);
      for (const [index, part] of parts.entries()) {
        if (!dropping) {
          if (pending.length + part.length > 32_768) {
            pending = '';
            dropping = true;
          } else pending += part;
        }
        if (index < parts.length - 1) finish();
      }
    },
    finish,
  };
}

/** Coalesce noisy processes to one latest line per second and drain before the next stage. */
export async function runMakeBuildStep(
  state: CindyMakePersonalBuildState,
  signal: AbortSignal,
  publish: (state: CindyMakePersonalBuildState) => Promise<void>,
  run: (onLine: (line: string) => void) => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  await publish(state);
  let pending: string | undefined;
  let lastLine: string | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  const schedule = () => {
    if (!closed && !timer && !writing && pending && !failure) {
      timer = setTimeout(flush, 1000);
      timer.unref?.();
    }
  };
  const flush = () => {
    timer = undefined;
    if (writing || !pending || signal.aborted || failure) return;
    const outputLine = pending;
    pending = undefined;
    writing = Promise.resolve()
      .then(() => {
        if (!signal.aborted) return publish({ ...state, outputLine });
      })
      .catch((error: unknown) => {
        failure = { error };
      })
      .finally(() => {
        writing = undefined;
        schedule();
      });
  };
  try {
    await run((value) => {
      if (closed || signal.aborted) return;
      const line = parseCindyMakeBuildOutput(value);
      if (!line || line === lastLine) return;
      pending = lastLine = line;
      schedule();
    });
  } finally {
    closed = true;
    clearTimeout(timer);
    await writing;
    flush();
    await writing;
  }
  if (failure) throw failure.error;
}
