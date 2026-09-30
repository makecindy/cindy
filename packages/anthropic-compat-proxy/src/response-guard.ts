import type { OutgoingHttpHeaders, OutgoingHttpHeader, ServerResponse } from 'node:http';
import type { Transform } from 'node:stream';

/** Validate every response path, including local protocol adapters, before client delivery. */
export function installResponseGuard(res: ServerResponse, create: () => Transform): void {
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((...args: [number, (string | OutgoingHttpHeaders | OutgoingHttpHeader[])?, (OutgoingHttpHeaders | OutgoingHttpHeader[])?]) => {
    const headers = typeof args[1] === 'string' ? args[2] : args[1];
    // writeHead's direct headers are otherwise absent from getHeaders().
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) res.setHeader(String(headers[i]), String(headers[i + 1]));
    } else if (headers) {
      for (const [name, value] of Object.entries(headers)) if (value !== undefined) res.setHeader(name, value);
    }
    return Reflect.apply(writeHead, res, args);
  }) as typeof res.writeHead;
  let guard: Transform | undefined;
  const get = (): Transform => {
    if (guard) return guard;
    guard = create();
    guard.on('data', (chunk: Buffer) => { if (!write(chunk)) guard!.pause(); });
    res.on('drain', () => guard?.resume());
    guard.once('end', () => end());
    guard.once('error', () => res.destroy());
    res.once('close', () => guard?.destroy());
    return guard;
  };
  res.write = ((chunk: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    try {
      const stream = get();
      const cb = typeof encoding === 'function' ? encoding : callback;
      const ready = stream.write(chunk, typeof encoding === 'string' ? encoding : 'utf8', cb);
      if (!ready) stream.once('drain', () => res.emit('drain'));
      return ready;
    } catch { res.destroy(); return false; }
  }) as typeof res.write;
  res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    const cb = typeof chunk === 'function' ? chunk as () => void
      : typeof encoding === 'function' ? encoding : callback;
    if (cb) res.once('finish', cb);
    try { get().end(typeof chunk === 'function' ? undefined : chunk, typeof encoding === 'string' ? encoding : 'utf8'); }
    catch { res.destroy(); }
    return res;
  }) as typeof res.end;
}
