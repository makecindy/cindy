import { randomUUID } from 'node:crypto';
import net from 'node:net';

import type { ReviewRunOwnerLiveness } from '../../shared/reviewRun.js';

const LOOPBACK_HOST = '127.0.0.1';
const PROBE_PREFIX = 'cindy-review-owner-v1:';
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;

export type ReviewOwnerLivenessProbeResult = 'alive' | 'ended' | 'unknown';

export interface ReviewOwnerLivenessHandle {
  identity: ReviewRunOwnerLiveness;
  close(): Promise<void>;
}

/**
 * Bind one challenge endpoint to this exact Main-process incarnation.
 * The OS releases the port on crash; a later unrelated port owner cannot pass
 * the random challenge even when the process id or port is reused.
 */
export async function startReviewOwnerLiveness(): Promise<ReviewOwnerLivenessHandle> {
  const token = randomUUID();
  const expectedReply = `${PROBE_PREFIX}${token}\n`;
  const server = net.createServer((socket) => {
    socket.end(expectedReply);
  });
  // A post-listen socket error must degrade the probe, not crash Desktop.
  server.on('error', () => undefined);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
  });
  server.unref();

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Review owner liveness endpoint did not expose a TCP port');
  }

  return {
    identity: { version: 1, port: address.port, token },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

/**
 * Verify an exact owner. Ambiguous transport failures are fail-closed: they
 * preserve the lease instead of risking concurrent Review runs.
 */
export async function probeReviewOwnerLiveness(
  identity: ReviewRunOwnerLiveness,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ReviewOwnerLivenessProbeResult> {
  const expectedReply = `${PROBE_PREFIX}${identity.token}\n`;
  return await new Promise<ReviewOwnerLivenessProbeResult>((resolve) => {
    let settled = false;
    let received = '';
    const socket = net.createConnection({ host: LOOPBACK_HOST, port: identity.port });
    const finish = (result: ReviewOwnerLivenessProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk) => {
      received += chunk;
      if (received === expectedReply) finish('alive');
      else if (!expectedReply.startsWith(received)) finish('ended');
      else if (received.length >= expectedReply.length) finish('ended');
    });
    socket.on('end', () => finish(received === expectedReply ? 'alive' : 'ended'));
    socket.on('timeout', () => finish('unknown'));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish('ended');
      else finish('unknown');
    });
  });
}
