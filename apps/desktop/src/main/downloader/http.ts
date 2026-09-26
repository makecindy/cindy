import { net } from 'electron';
import { Readable } from 'node:stream';

/** Electron fetch rejects manual redirects instead of returning their response.
 * Keep redirect decisions in transport, and expose the native Readable as a Web
 * stream so awaited disk writes propagate backpressure to Chromium.
 */
export function requestResponse(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET', redirect: 'manual' });
    new Headers(init.headers).forEach((value, name) => request.setHeader(name, value));
    let settled = false;
    const signal = init.signal;
    const detach = () => signal?.removeEventListener('abort', abort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      detach();
      reject(error);
    };
    const abort = () => {
      fail(new Error('Request aborted'));
      request.abort();
    };
    request.on('error', fail);
    request.on('redirect', (status, _method, location) => {
      if (settled) return;
      settled = true;
      detach();
      // Do not follow here: transport validates the next URL before requesting it.
      resolve(new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.on('response', (incoming) => {
      if (settled) return;
      settled = true;
      // Electron IncomingMessage implements Readable; its typings omit stream methods.
      const stream = incoming as unknown as Readable;
      const headers = new Headers();
      for (const [name, values] of Object.entries(incoming.headers)) {
        for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
      }
      stream.once('end', detach);
      stream.once('close', () => {
        detach();
        if (!stream.readableEnded) request.abort();
      });
      const body = [204, 205, 304].includes(incoming.statusCode)
        ? null
        : Readable.toWeb(stream, {
            strategy: { highWaterMark: 64 * 1024, size: (chunk: Buffer) => chunk.byteLength },
          });
      if (body === null) {
        stream.once('error', detach);
        stream.resume();
      }
      resolve(
        new Response(body as ReadableStream<Uint8Array> | null, {
          status: incoming.statusCode,
          headers,
        }),
      );
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    request.end();
  });
}
