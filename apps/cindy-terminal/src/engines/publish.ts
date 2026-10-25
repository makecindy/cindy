import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Windows scanners can briefly retain downloaded executable handles.
 * Retry only publication into a new unique directory; never delete/replace the
 * currently active version to work around a lock or a permanent ACL failure. */
export async function publishEngineDirectory(
  from: string,
  to: string,
  signal?: AbortSignal,
  host: {
    platform?: NodeJS.Platform;
    rename?: typeof rename;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<void> {
  const move = host.rename ?? rename;
  const wait = host.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (
        (host.platform ?? process.platform) !== "win32" ||
        attempt >= 5 ||
        !code ||
        !["EPERM", "EACCES", "EBUSY"].includes(code)
      )
        throw error;
      await wait(100 * (attempt + 1), signal);
    }
  }
}
