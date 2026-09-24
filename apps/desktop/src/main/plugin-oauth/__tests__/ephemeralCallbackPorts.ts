import http from 'node:http';
import type { AddressInfo, ListenOptions } from 'node:net';
import { expect, vi } from 'vitest';

/** Keep real HTTP handlers/sockets, but allocate ports at bind time, not with a racy probe. */
export function ephemeralCallbackPorts() {
  const servers = new Map<string, http.Server>();
  const ports = new Map<string, number>();
  const original = http.Server.prototype.listen;
  const listen = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
    this: http.Server,
    ...args: unknown[]
  ) {
    const options = args[0] as ListenOptions;
    // 12345 is only the logical callback authority, never an OS port reservation.
    // Conflict tests restore this spy and retain an actual listen(0) owner.
    expect(options).toMatchObject({ port: 12345, ipv6Only: options.host === '::1' });
    expect(['127.0.0.1', '::1']).toContain(options.host);
    servers.set(options.host!, this);
    this.once('listening', () => ports.set(options.host!, (this.address() as AddressInfo).port));
    return Reflect.apply(original, this, [{ ...options, port: 0 }, ...args.slice(1)]);
  });
  const port = (host: string) => {
    const value = ports.get(host);
    if (value === undefined) throw new Error(`No callback listener for ${host}`);
    return value;
  };
  return {
    servers,
    listen,
    port,
    fetch(raw: string, init?: RequestInit) {
      const url = new URL(raw);
      const authority = url.host;
      url.port = String(port(url.hostname === '[::1]' ? '::1' : url.hostname));
      const headers = new Headers(init?.headers);
      if (!headers.has('Host')) headers.set('Host', authority);
      // Node fetch may replace Host with the transport authority. Send the
      // original callback authority explicitly while connecting to the owned port.
      return new Promise<Response>((resolve, reject) => {
        const req = http.request(
          url,
          {
            method: init?.method,
            headers: Object.fromEntries(headers),
            agent: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () =>
              resolve(
                new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), {
                  status: res.statusCode,
                }),
              ),
            );
          },
        );
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('Callback request timed out')));
        req.end();
      });
    },
  };
}
