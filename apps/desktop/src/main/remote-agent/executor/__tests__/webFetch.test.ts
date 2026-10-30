import { SsrFBlockedError } from '@cindy/browser-control-runtime/ssrf-runtime';
import { describe, expect, it } from 'vitest';

import { fetchWebPage, htmlToText, WEB_FETCH_PAGE_CHARS, type GuardedFetch } from '../webFetch';

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? '').join('');
}

/** 按地址回应的假出站通道，记录每一跳。 */
function fakeFetch(routes: Record<string, () => Response>): { fetch: GuardedFetch; hops: string[]; released: number } {
  const state = { hops: [] as string[], released: 0 };
  const fetch: GuardedFetch = async (url) => {
    state.hops.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${url}`);
    return { response: route(), release: async () => { state.released += 1; } };
  };
  return { fetch, get hops() { return state.hops; }, get released() { return state.released; } };
}

const html = (body: string, headers: Record<string, string> = {}) => () => new Response(body, {
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
});

describe('htmlToText', () => {
  it('keeps headings, links, lists and code blocks and drops scripts, styles and markup', () => {
    const { title, text: out } = htmlToText([
      '<html><head><title>Guide &amp; Notes</title><style>p{color:red}</style></head><body>',
      '<script>alert(1)</script><!-- note -->',
      '<h1>Install</h1><p>Run   the\n installer from <a href="/download?a=1&amp;b=2">the site</a>.</p>',
      '<ul><li>One</li><li>Two &lt;b&gt;</li></ul>',
      '<pre><code>npm  install\n  cindy</code></pre>',
      '<p>Bad <a href="javascript:alert(1)">link</a> and <a href="#top">anchor</a>; caf&eacute;&nbsp;&#x263A; &Uuml;ber &AMP; &#1;</p>',
      '<p>Unclosed <a href="https://x.example/">tail',
      '</body></html>',
    ].join(''), new URL('https://docs.example.com/guide/'));
    expect(title).toBe('Guide & Notes');
    expect(out).toContain('# Install');
    expect(out).toContain('Run the installer from [the site](https://docs.example.com/download?a=1&b=2).');
    expect(out).toContain('- One\n- Two <b>');
    expect(out).toContain('```\nnpm  install\n  cindy\n```');
    expect(out).toContain('Bad link and anchor; café ☺ Über &');
    expect(out).toContain('Unclosed tail');
    expect(out).not.toMatch(/alert|color:red|note|x\.example|[\u0001-\u0004]/);
  });
});

describe('fetchWebPage', () => {
  it('upgrades http, follows redirects on the same site and returns the page text', async () => {
    const fake = fakeFetch({
      'https://example.com/a': () => new Response(null, { status: 301, headers: { location: 'https://www.example.com/b' } }),
      'https://www.example.com/b': html('<title>B</title><p>Body text</p>'),
    });
    const result = await fetchWebPage(fake.fetch, { url: new URL('http://example.com/a'), startIndex: 0, allowPrivateNetwork: false });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe('URL: https://www.example.com/b\nTitle: B\n\nBody text');
    expect(fake.hops).toEqual(['https://example.com/a', 'https://www.example.com/b']);
    expect(fake.released).toBe(2);
  });

  it('hands redirects to another host back to the agent instead of following them', async () => {
    const fake = fakeFetch({
      'https://example.com/go': () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } }),
    });
    const result = await fetchWebPage(fake.fetch, { url: new URL('https://example.com/go'), startIndex: 0, allowPrivateNetwork: false });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('redirected to a different host: http://169.254.169.254/latest/');
    expect(fake.hops).toEqual(['https://example.com/go']);
  });

  it('keeps http and the private network only for an approved address', async () => {
    const approvals: unknown[] = [];
    const fetch: GuardedFetch = async (url, _init, _before, approval) => {
      approvals.push({ url, ...approval });
      return { response: new Response('plain', { headers: { 'content-type': 'text/plain' } }), release: async () => {} };
    };
    await fetchWebPage(fetch, { url: new URL('http://10.0.0.5/wiki'), startIndex: 0, allowPrivateNetwork: true });
    expect(approvals).toEqual([{ url: 'http://10.0.0.5/wiki', targetUrl: 'http://10.0.0.5/wiki', allowHttp: true, allowPrivateNetwork: true }]);
  });

  it('explains private-network blocks, HTTP errors, loops and non-text content', async () => {
    const blocked: GuardedFetch = async () => {
      throw new SsrFBlockedError('Blocked: resolves to private/internal/special-use IP address');
    };
    const privateResult = await fetchWebPage(blocked, { url: new URL('https://intranet.example/'), startIndex: 0, allowPrivateNetwork: false });
    expect(privateResult.isError).toBe(true);
    expect(text(privateResult)).toContain('private network');

    const fake = fakeFetch({
      'https://example.com/404': () => new Response('nope', { status: 404, statusText: 'Not Found' }),
      'https://example.com/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }),
      'https://example.com/logo.png': () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }),
    });
    const notFound = await fetchWebPage(fake.fetch, { url: new URL('https://example.com/404'), startIndex: 0, allowPrivateNetwork: false });
    expect(text(notFound)).toBe('https://example.com/404 returned HTTP 404 Not Found.');
    const loop = await fetchWebPage(fake.fetch, { url: new URL('https://example.com/loop'), startIndex: 0, allowPrivateNetwork: false });
    expect(text(loop)).toContain('loop');
    const image = await fetchWebPage(fake.fetch, { url: new URL('https://example.com/logo.png'), startIndex: 0, allowPrivateNetwork: false });
    expect(image.isError).toBe(true);
    expect(text(image)).toContain('image/png, not a text page');
  });

  it('returns long pages in parts and decodes the declared charset', async () => {
    const long = 'x'.repeat(WEB_FETCH_PAGE_CHARS + 10);
    const fake = fakeFetch({
      'https://example.com/long': () => new Response(long, { headers: { 'content-type': 'text/plain' } }),
      'https://example.com/latin': () => new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), { headers: { 'content-type': 'text/plain; charset=iso-8859-1' } }),
    });
    const first = await fetchWebPage(fake.fetch, { url: new URL('https://example.com/long'), startIndex: 0, allowPrivateNetwork: false });
    expect(text(first)).toContain(`Characters 0–${WEB_FETCH_PAGE_CHARS} of ${WEB_FETCH_PAGE_CHARS + 10}. Call WebFetch again with start_index=${WEB_FETCH_PAGE_CHARS}`);
    const rest = await fetchWebPage(fake.fetch, { url: new URL('https://example.com/long'), startIndex: WEB_FETCH_PAGE_CHARS, allowPrivateNetwork: false });
    expect(text(rest).endsWith('\n\nxxxxxxxxxx')).toBe(true);
    const latin = await fetchWebPage(fake.fetch, { url: new URL('https://example.com/latin'), startIndex: 0, allowPrivateNetwork: false });
    expect(text(latin)).toBe('URL: https://example.com/latin\n\ncafé');
  });
});
