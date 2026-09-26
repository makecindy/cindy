import { describe, expect, it, vi } from 'vitest';
import { fetchSingleHopWithSsrFGuard, SsrFBlockedError } from '@cindy/browser-control-runtime/ssrf-runtime';
import { createXaiVideoProxyLookup } from '../xaiVideoProxyDns.js';

const answer = (addresses: string[]) => ({ Status: 0, Question: [{ name: 'vidgen.x.ai', type: 1 }],
  Answer: addresses.map((data) => ({ name: 'vidgen.x.ai', type: 1, data })) });

describe('xAI CDN proxy DNS without weakening the real SSRF guard', () => {
  it('feeds vetted HTTPS DNS results to the real guard and pins them before any connection', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(answer(['104.18.18.80', '104.18.19.80']))));
    const lookup = createXaiVideoProxyLookup(fetch as typeof globalThis.fetch);
    let pinned: string[] = [];
    await expect(fetchSingleHopWithSsrFGuard({
      url: 'https://vidgen.x.ai/private-result?sig=not-for-dns', lookupFn: lookup,
      dispatcherFactory: ({ pinned: selected }) => { pinned = selected.addresses; throw new Error('offline connection boundary'); },
    })).rejects.toThrow('offline connection boundary');
    expect(pinned).toEqual(['104.18.18.80', '104.18.19.80']);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get('name')).toBe('vidgen.x.ai');
    expect(String(url).includes('private-result')).toBe(false);
    expect(JSON.stringify(init.headers)).toBe(JSON.stringify({ Accept: 'application/dns-json' }));
    expect(init.redirect).toBe('error');
  });
  it.each(['127.0.0.1', '169.254.169.254', '10.0.0.1', '198.18.0.1'])('rejects unsafe HTTPS DNS answer %s in the real SSRF gate', async (address) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(answer([address]))));
    const connection = vi.fn();
    await expect(fetchSingleHopWithSsrFGuard({ url: 'https://vidgen.x.ai/result',
      lookupFn: createXaiVideoProxyLookup(fetch as typeof globalThis.fetch), dispatcherFactory: connection,
    })).rejects.toBeInstanceOf(SsrFBlockedError);
    expect(connection.mock.calls.length).toBe(0);
  });
  it('does not query arbitrary hostnames', async () => {
    const fetch = vi.fn();
    await expect(createXaiVideoProxyLookup(fetch)('unrelated.example', { all: true })).rejects.toMatchObject({ code: 'XAI_CDN_DNS_UNAVAILABLE' });
    expect(fetch.mock.calls.length).toBe(0);
  });
  it.each(['http', 'oversize', 'badQuestion', 'empty', 'network'])('fails closed for %s without disclosing raw errors', async (kind) => {
    const fetch = vi.fn(async () => {
      if (kind === 'network') throw new Error('signed-secret-url');
      if (kind === 'http') return new Response('', { status: 503 });
      if (kind === 'oversize') return new Response('x'.repeat(17000));
      if (kind === 'badQuestion') return new Response(JSON.stringify({ ...answer(['104.18.18.80']), Question: [{ name: 'other.example', type: 1 }] }));
      return new Response(JSON.stringify(answer([])));
    });
    let error: unknown;
    try { await createXaiVideoProxyLookup(fetch as typeof globalThis.fetch)('vidgen.x.ai', { all: true }); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'XAI_CDN_DNS_UNAVAILABLE' });
    expect(String(error).includes('signed-secret-url')).toBe(false);
  });
});
