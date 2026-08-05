/**
 * Single-consumer async queue — many-producers push + single end().
 *
 * Copied verbatim from maker-core/src/agents/shared/async-queue.ts so this
 * package stays zero-internal-deps (manager binary is esbuild-bundled and
 * shipped to remote SSH machines, can't pull in maker-core).
 */

export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  end(): void;
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const waiters: Array<(done: boolean) => void> = [];
  let ended = false;

  function push(item: T): void {
    if (ended) return;
    if (waiters.length > 0) {
      items.push(item);
      waiters.shift()!(false);
    } else {
      items.push(item);
    }
  }

  function end(): void {
    if (ended) return;
    ended = true;
    while (waiters.length > 0) {
      waiters.shift()!(true);
    }
  }

  async function* iterate(): AsyncGenerator<T> {
    while (true) {
      if (items.length > 0) {
        yield items.shift() as T;
      } else if (ended) {
        return;
      } else {
        await new Promise<boolean>((resolve) => {
          waiters.push(resolve);
        });
      }
    }
  }

  return {
    push,
    end,
    [Symbol.asyncIterator]: () => iterate(),
  };
}
