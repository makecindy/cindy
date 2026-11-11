import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';

import {
  probeReviewOwnerLiveness,
  startReviewOwnerLiveness,
  type ReviewOwnerLivenessHandle,
} from '../reviewOwnerLiveness.js';

const LOOPBACK_HOST = '127.0.0.1';

async function listen(handler: (socket: net.Socket) => void): Promise<net.Server> {
  const server = net.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, resolve);
  });
  return server;
}

function addressPort(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP port');
  return address.port;
}

describe('Review owner exact liveness', () => {
  let handle: ReviewOwnerLivenessHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  it('recognizes only the exact live Main instance challenge', async () => {
    handle = await startReviewOwnerLiveness();

    await expect(probeReviewOwnerLiveness(handle.identity)).resolves.toBe('alive');
    await expect(
      probeReviewOwnerLiveness({ ...handle.identity, token: 'wrong-instance-token' }),
    ).resolves.toBe('ended');
  });

  it('reports the owner ended after its endpoint closes', async () => {
    handle = await startReviewOwnerLiveness();
    const identity = handle.identity;
    await handle.close();
    handle = null;

    await expect(probeReviewOwnerLiveness(identity)).resolves.toBe('ended');
  });

  it('treats connection reset and aborted pipes as the owner having ended', async () => {
    const server = await listen((socket) => {
      socket.resetAndDestroy();
    });
    try {
      await expect(
        probeReviewOwnerLiveness({
          version: 1,
          port: addressPort(server),
          token: '1234567890abcdef',
        }),
      ).resolves.toBe('ended');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps an accepted probe unknown when the endpoint never completes the challenge', async () => {
    const server = await listen(() => {
      // Hold the accepted socket open without the owner challenge.
    });
    try {
      await expect(
        probeReviewOwnerLiveness(
          {
            version: 1,
            port: addressPort(server),
            token: '1234567890abcdef',
          },
          50,
        ),
      ).resolves.toBe('unknown');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
