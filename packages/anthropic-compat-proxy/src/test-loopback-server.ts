import type { Server } from 'node:http';
import { Agent, fetch as undiciFetch } from 'undici';

const LOOPBACK_LISTEN_MAX_ATTEMPTS = 32;

// Every proxy binds a random port in 49152-65535, so a test's new proxy can land on
// the port of one the previous test disposed. A keep-alive pool such as global fetch's
// would then send the request over the old, closed socket before reading its FIN
// (Windows CI: `fetch failed`, read ECONNRESET). One connection per request.
const freshConnections = new Agent({ pipelining: 0 });

/** `fetch` for requests to a test's proxy: never reuses a connection across requests. */
export const fetchOverFreshConnection = (
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> => undiciFetch(input, { ...init, dispatcher: freshConnections });

function isRetryableListenError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

function listenOnce(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === 'string') {
        const error = new Error('test loopback server failed to resolve its listening port');
        server.close(() => reject(error));
        return;
      }
      resolve(address.port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(0, '127.0.0.1');
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/**
 * Starts a test-only HTTP server while tolerating Windows excluded-port races.
 * Windows can occasionally assign an unavailable excluded port for listen(0),
 * surfacing EACCES even though another ephemeral port is available.
 */
export async function listenOnAvailableLoopbackPort(server: Server): Promise<number> {
  let lastRetryableError: Error | null = null;

  for (let attempt = 1; attempt <= LOOPBACK_LISTEN_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await listenOnce(server);
    } catch (error) {
      if (!isRetryableListenError(error)) throw error;
      lastRetryableError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `test loopback server failed to bind after ${LOOPBACK_LISTEN_MAX_ATTEMPTS} attempts` +
      (lastRetryableError === null ? '' : `; last error ${lastRetryableError.message}`),
  );
}
