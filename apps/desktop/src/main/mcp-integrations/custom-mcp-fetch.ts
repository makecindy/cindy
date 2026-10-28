import { Agent, fetch as undiciFetch } from 'undici';
import dns from 'node:dns';
import { isIP } from 'node:net';

function normalizedHost(host: string): string {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return isIP(value) === 6 ? new URL('http://[' + value + ']').hostname.slice(1, -1) : value;
}
function loopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}
/** LAN HTTPS is intentional; link-local/metadata, unspecified and multicast are not. */
export function isForbiddenMcpAddress(input: string): boolean {
  const address = normalizedHost(input);
  if (address.includes(':')) {
    // URL canonicalization expands IPv4-mapped IPv6 to hexadecimal groups.
    if (address.startsWith('::ffff:')) {
      const tail = address.slice(7);
      if (isIP(tail) === 4) return isForbiddenMcpAddress(tail);
      const parts = tail.split(':').map((part) => parseInt(part, 16));
      if (parts.length !== 2 || parts.some(Number.isNaN)) return true;
      return isForbiddenMcpAddress(
        [parts[0] >> 8, parts[0] & 255, parts[1] >> 8, parts[1] & 255].join('.'),
      );
    }
    return (
      address === '::' ||
      /^f[ef][89ab]/.test(address) ||
      /^ff/.test(address) ||
      address === 'fd00:ec2::254'
    );
  }
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a >= 224 || (a === 169 && b === 254) || address === '100.100.100.200';
}
export function validateMcpEndpoint(value: string, strict = true): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_CONFIG');
  }
  const host = normalizedHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (!strict || loopback(host))))
    throw new Error('INSECURE_ENDPOINT');
  if (strict && (url.username || url.password || url.search || url.hash))
    throw new Error('INVALID_CONFIG');
  if (isIP(host) && isForbiddenMcpAddress(host)) throw new Error('INSECURE_ENDPOINT');
  return url;
}

/** Each socket uses the validated lookup result, so a second DNS lookup cannot rebind it. */
export function createMcpFetch(
  endpoint: string,
  responseLimit = 32 * 1024 * 1024,
  aggregate = false,
) {
  const confirmed = validateMcpEndpoint(endpoint, false);
  let failure: string | undefined;
  let total = 0;
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dns.lookup(hostname, { all: true }, (error, addresses) => {
          if (error) {
            callback(error, '', 4);
            return;
          }
          const allowed = addresses.filter(
            (a) =>
              !isForbiddenMcpAddress(a.address) &&
              (!loopback(normalizedHost(confirmed.hostname)) ||
                loopback(normalizedHost(a.address))),
          );
          if (!allowed.length || allowed.length !== addresses.length) {
            failure = 'INSECURE_ENDPOINT';
            callback(new Error('INSECURE_ENDPOINT'), '', 4);
            return;
          }
          const family = typeof options === 'object' ? options.family : options;
          const selected = allowed.find((a) => !family || a.family === family) ?? allowed[0];
          if (typeof options === 'object' && options.all) callback(null, allowed);
          else callback(null, selected.address, selected.family);
        });
      },
    },
  });
  const safeFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== confirmed.origin || url.username || url.password) {
      failure = 'REDIRECT_REQUIRES_REVIEW';
      throw new Error(failure);
    }
    try {
      const response = await undiciFetch(url, {
        ...init,
        dispatcher,
        redirect: 'manual',
      } as Parameters<typeof undiciFetch>[1]);
      if (response.status >= 300 && response.status < 400) {
        failure = 'REDIRECT_REQUIRES_REVIEW';
        await response.body?.cancel();
        throw new Error(failure);
      }
      if (response.status === 401 || response.status === 403) {
        failure = 'AUTH_REJECTED';
        await response.body?.cancel();
        throw new Error(failure);
      }
      const reader = response.body?.getReader();
      let size = 0;
      const body = reader
        ? new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  controller.close();
                  return;
                }
                size += next.value.byteLength;
                total += next.value.byteLength;
                if (size > responseLimit || (aggregate && total > responseLimit)) {
                  failure = 'RESPONSE_LIMIT';
                  await reader.cancel();
                  throw new Error(failure);
                }
                controller.enqueue(next.value);
              } catch {
                controller.error(new Error(failure ?? 'PROTOCOL_MISMATCH'));
              }
            },
            cancel: () => reader.cancel(),
          })
        : null;
      return new Response(body, {
        status: response.status,
        statusText: '',
        headers: [...response.headers],
      });
    } catch {
      throw new Error(failure ?? 'PROTOCOL_MISMATCH');
    }
  };
  return { fetch: safeFetch, errorCode: () => failure, close: () => dispatcher.destroy() };
}
