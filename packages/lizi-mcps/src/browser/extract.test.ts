import { describe, expect, it } from 'vitest';

import { buildExtractFnSource, collectSelectors, type ExtractSpec } from './extract.js';

/** Parse the generated arrow-function source into a callable (page-free smoke). */
function compile(src: string): () => unknown {
  // The source is an arrow-function expression; wrap to return it.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`return (${src});`)() as () => unknown;
}

describe('buildExtractFnSource', () => {
  it('produces a syntactically valid zero-arg function', () => {
    const spec: ExtractSpec = { from: '.item', multiple: true, fields: { title: '.t' } };
    const src = buildExtractFnSource(spec);
    expect(() => compile(src)).not.toThrow();
    expect(src.startsWith('() =>')).toBe(true);
  });

  it('embeds selectors as JSON data, not concatenated code (injection-safe)', () => {
    // A selector containing quotes/braces must not break out of the source.
    const spec: ExtractSpec = { fields: { x: 'a[href="x"]:not(.y)' } };
    const src = buildExtractFnSource(spec);
    expect(() => compile(src)).not.toThrow();
    // The selector survives intact as a JSON string literal.
    expect(src).toContain(JSON.stringify('a[href="x"]:not(.y)'));
  });

  // CodeQL #423: JSON quoting alone leaves script delimiters and JS line
  // separators in executable source. Exercise the generated function as well
  // as its code/data boundary; selector and attribute values must round-trip.
  it('escapes script delimiters and line separators without altering DOM read data', () => {
    const payload = '</script><SCRIPT>throw new Error("injected")</SCRIPT>\u2028\u2029';
    const src = buildExtractFnSource({ fields: { value: { selector: payload, attr: payload } } });
    expect(src).not.toMatch(/<\/?script>|[\u2028\u2029]/iu);
    const received: string[] = [];
    const g = globalThis as unknown as { document?: unknown };
    const previous = g.document;
    g.document = { querySelector: (selector: string) => {
      received.push(selector);
      return { getAttribute: (attribute: string) => { received.push(attribute); return 'read result'; } };
    } };
    try {
      expect(compile(src)()).toEqual({ ok: true, count: 1, records: [{ value: 'read result' }] });
      expect(received).toEqual([payload, payload]);
    } finally {
      g.document = previous;
    }
  });

  it('expands a string field shorthand to a text-type field', () => {
    const src = buildExtractFnSource({ fields: { title: '.t' } });
    expect(src).toContain('"title":{"selector":".t","type":"text"}');
  });

  it('keeps explicit field specs and defaults type to attr when only attr is given', () => {
    const src = buildExtractFnSource({
      fields: {
        link: { selector: 'a', type: 'href' },
        id: { attr: 'data-id' },
      },
    });
    expect(src).toContain('"link":{"selector":"a","type":"href"}');
    expect(src).toContain('"id":{"attr":"data-id","type":"attr"}');
  });

  it('carries from/multiple/limit into the embedded spec', () => {
    const src = buildExtractFnSource({ from: '.row', multiple: true, limit: 25, fields: { a: '.a' } });
    expect(src).toContain('"from":".row"');
    expect(src).toContain('"multiple":true');
    expect(src).toContain('"limit":25');
  });

  it('guards an invalid selector at runtime: returns ok:false + hint, does not throw', () => {
    // Exercise the generated fn against a fake DOM where a bad selector throws
    // (as a real browser's querySelector does on invalid CSS).
    const fakeDoc = {
      querySelectorAll(s: string) {
        if (s.includes('@') || s.includes(' (')) throw new SyntaxError('invalid');
        return [];
      },
      querySelector(s: string) {
        if (s.includes('@') || s.includes(' (')) throw new SyntaxError('invalid');
        return null;
      },
    };
    const g = globalThis as unknown as { document?: unknown; location?: unknown };
    const prevDoc = g.document;
    const prevLoc = g.location;
    g.document = fakeDoc;
    g.location = { href: 'https://x/' };
    try {
      const fn = compile(buildExtractFnSource({ from: 'h3 a@title', multiple: true, fields: { t: '.t' } })) as () => {
        ok: boolean;
        error?: string;
        hint?: string;
      };
      const out = fn();
      expect(out.ok).toBe(false);
      expect(out.error).toContain('h3 a@title');
      expect(out.hint).toBeTruthy();
    } finally {
      g.document = prevDoc;
      g.location = prevLoc;
    }
  });
});

describe('collectSelectors', () => {
  it('gathers from + field selectors (shorthand and object form)', () => {
    const sels = collectSelectors({
      from: '.row',
      fields: { a: '.a', b: { selector: 'h3 a', attr: 'title' }, c: { attr: 'data-x' } },
    });
    expect(sels.sort()).toEqual(['.a', '.row', 'h3 a']);
  });

  it('surfaces the "selector@attr" mistake so the handler can pre-empt it', () => {
    const sels = collectSelectors({ fields: { t: 'h3 a@title' } });
    expect(sels.some((s) => s.includes('@'))).toBe(true);
  });
});
