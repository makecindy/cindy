// The fixed "text" read (2026-11-12). Unit tier: the generated page function runs here against a stand-in
// document, so no browser is needed.
// Rules protected: the read returns what a person sees (innerText, blank runs collapsed) together with the
// page's own address and load state; the spec is data and can never become code; an invalid or unmatched
// selector is reported, not thrown. No earlier test covered this: the read kind did not exist.
import { describe, expect, it } from 'vitest';
import { buildDomReadSource, buildPageTextFnSource, type PageText, type PageTextSpec } from '../dom-read.js';

function run(spec: PageTextSpec, page: { text?: string; selectors?: Record<string, string | null>; readyState?: string } = {}): PageText {
  const element = (text: string) => ({ innerText: text, textContent: `${text}<hidden>` });
  const document = {
    title: 'A page',
    readyState: page.readyState ?? 'complete',
    body: element(page.text ?? 'Head  \n\n\n\nBody\t\nTail'),
    querySelector(selector: string) {
      if (selector.includes('(')) throw new SyntaxError('not a selector');
      const text = page.selectors?.[selector];
      return typeof text === 'string' ? element(text) : null;
    },
  };
  const location = { href: 'https://example.test/doc' };
  return new Function('document', 'location', `return (${buildPageTextFnSource(spec)})();`)(document, location) as PageText;
}

describe('fixed text read', () => {
  it('returns the rendered text with blank runs collapsed, and where the page is', () => {
    expect(run({})).toEqual({
      ok: true, url: 'https://example.test/doc', title: 'A page', readyState: 'complete', found: true,
      length: 15, text: 'Head\n\nBody\nTail',
    });
  });

  it('cuts by offset and maxChars but reports the whole length; maxChars 0 is a state probe', () => {
    expect(run({ offset: 6, maxChars: 4 })).toMatchObject({ length: 15, text: 'Body' });
    expect(run({ maxChars: 0 }, { readyState: 'interactive' })).toMatchObject({ readyState: 'interactive', length: 15, text: '' });
  });

  it('reads one part of the page, and says when the selector matches nothing or is not CSS', () => {
    const selectors = { main: 'Main part' };
    expect(run({ selector: 'main' }, { selectors })).toMatchObject({ ok: true, found: true, text: 'Main part' });
    expect(run({ selector: '.missing' }, { selectors })).toMatchObject({ ok: true, found: false, length: 0, text: '' });
    expect(run({ selector: 'not a selector(' }, { selectors })).toMatchObject({ ok: false, found: false, error: expect.stringContaining('not a selector(') });
  });

  it('embeds the spec as data: a selector cannot break out of the generated source', () => {
    const hostile = `x'); globalThis.pwned = true; ('</script><script>`;
    const source = buildDomReadSource({ kind: 'text', text: { selector: hostile } });
    expect(source).not.toContain('</script>');
    expect(run({ selector: hostile })).toMatchObject({ found: false, text: '' });
    expect((globalThis as { pwned?: unknown }).pwned).toBeUndefined();
  });

  it('is refused when the spec is not one of the fixed shapes', () => {
    expect(() => buildDomReadSource({ kind: 'text', text: { maxChars: 1_000_000 } })).toThrow();
    expect(() => buildDomReadSource({ kind: 'text', text: {}, fn: '() => 1' })).toThrow();
  });
});
