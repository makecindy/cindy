import { parse } from 'acorn';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { MOBILE_MERMAID_JS } from '@/session/richContentAssets.generated';

const { JSDOM } = createRequire(import.meta.url)('jsdom');

function legacyWebView() {
  const context = createContext({ setTimeout, clearTimeout, URL: class extends URL {} });
  context.window = context;
  runInContext(`
    Object.defineProperty(URL, 'canParse', { configurable: true, writable: true, value: undefined });
    delete Object.hasOwn;
    delete Array.prototype.at;
    delete String.prototype.at;
    delete String.prototype.replaceAll;
    delete globalThis.structuredClone;
  `, context);
  runInContext(MOBILE_MERMAID_JS, context, { timeout: 10_000 });
  return context;
}

describe('Mobile Mermaid legacy WebView compatibility', () => {
  it('keeps the shipped resource parseable as ES2019', () => {
    expect(() => parse(MOBILE_MERMAID_JS, { ecmaVersion: 2019 })).not.toThrow();
  });

  it('loads Mermaid when modern runtime APIs are missing', () => {
    const context = legacyWebView();
    expect(runInContext('typeof window.mermaid.parse', context)).toBe('function');
    expect(runInContext('typeof window.mermaid.render', context)).toBe('function');
    expect(runInContext(`
      var object = Object.create(null); object.present = undefined;
      Object.hasOwn(object, 'present') && !Object.hasOwn(object, 'toString');
    `, context)).toBe(true);
    expect(runInContext('[1,2,3].at(-1)', context)).toBe(3);
    expect(runInContext('[1,2,3].at(-4)', context)).toBeUndefined();
    expect(runInContext('[1,2,3].at(Infinity)', context)).toBeUndefined();
    expect(runInContext(`String.prototype.at.call(123, -1)`, context)).toBe('3');
    expect(runInContext(`'abc'.at(NaN)`, context)).toBe('a');
  });

  it('preserves literal, empty, regex and functional replacements', () => {
    const context = legacyWebView();
    expect(runInContext(`'a.*a'.replaceAll('.', '!')`, context)).toBe('a!*a');
    expect(runInContext(`'[]{}()$^+?|'.replaceAll('$', '$&$&')`, context)).toBe('[]{}()$$^+?|');
    expect(runInContext(`'ab'.replaceAll('', '-')`, context)).toBe('-a-b-');
    expect(runInContext(`'aba'.replaceAll(/a/g, 'x')`, context)).toBe('xbx');
    expect(runInContext(`'aba'.replaceAll('a', (match, index) => String(index))`, context)).toBe('0b2');
    expect(() => runInContext(`'aba'.replaceAll(/a/, 'x')`, context)).toThrow();
    expect(() => runInContext('String.prototype.replaceAll.call(null, "a", "b")', context)).toThrow();
  });

  it('checks URLs through the constructor without swallowing string conversion errors', () => {
    const context = legacyWebView();
    expect(runInContext(`URL.canParse('https:example.com/diagram')`, context)).toBe(true);
    expect(runInContext(`URL.canParse('/diagram', 'https://example.com/')`, context)).toBe(true);
    expect(runInContext(`URL.canParse('/diagram')`, context)).toBe(false);
    expect(runInContext(`URL.canParse('https://[invalid')`, context)).toBe(false);
    expect(runInContext(`URL.canParse('https://example.com/', 'invalid base')`, context)).toBe(false);
    expect(runInContext(`URL.canParse(undefined)`, context)).toBe(false);
    expect(() => runInContext('URL.canParse()', context)).toThrow();
    expect(() => runInContext('URL.canParse(Symbol())', context)).toThrow();
    expect(() => runInContext(`URL.canParse('https://example.com/', Symbol())`, context)).toThrow();
    expect(() => runInContext(`URL.canParse({ toString() { throw new Error('conversion'); } })`, context)).toThrow('conversion');
  });

  it('parses and renders link diagrams with missing legacy APIs and strict URL sanitization', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only', url: 'https://xdt-maker-mobile.local/',
    });
    const context = dom.getInternalVMContext();
    try {
      runInContext(`
        delete URL.canParse;
        delete Object.hasOwn;
        delete Array.prototype.at;
        delete String.prototype.at;
        delete String.prototype.replaceAll;
        delete globalThis.structuredClone;
      `, context);
      runInContext(MOBILE_MERMAID_JS, context, { timeout: 10_000 });
      // JSDOM has no SVG layout engine; only text measurements are stubbed.
      // The actual bundled parser, sanitizer, graph layout and renderer all run.
      runInContext(`
        SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: 80, height: 24 }; };
        SVGElement.prototype.getComputedTextLength = function () { return this.textContent.length * 8; };
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', flowchart: { htmlLabels: false } });
      `, context);
      const diagram = 'flowchart TD\n A[Link] --> B[Done]\n click A href "https:example.com/diagram"';
      context.diagram = diagram;
      const parsed = await runInContext('mermaid.parse(diagram)', context);
      expect(parsed.diagramType).toBe('flowchart-v2');
      const rendered = await runInContext(`mermaid.render('legacy-link', diagram)`, context);
      const svg = new dom.window.DOMParser().parseFromString(rendered.svg, 'image/svg+xml');
      expect(svg.documentElement.localName).toBe('svg');
      expect(svg.querySelector('a')?.getAttribute('href')).toBe('https://example.com/diagram');
      expect(svg.documentElement.textContent).toContain('Link');
      expect(svg.documentElement.textContent).toContain('Done');

      context.diagram = diagram.replace('https:example.com/diagram', 'javascript:alert(1)');
      const blocked = await runInContext(`mermaid.render('legacy-blocked', diagram)`, context);
      const blockedSvg = new dom.window.DOMParser().parseFromString(blocked.svg, 'image/svg+xml');
      // The URL sanitizer maps this scheme to about:blank, then strict DOMPurify
      // removes the href altogether from the final SVG.
      expect(blockedSvg.querySelector('a')).not.toBeNull();
      expect(blockedSvg.querySelector('a')?.getAttribute('href')).toBeNull();
      await expect(runInContext(`mermaid.parse('flowchart TD\\n A[')`, context)).rejects.toThrow();
    } finally {
      dom.window.close();
    }
  });

  it('clones graph data with cycles, dates and collections', () => {
    const context = legacyWebView();
    expect(runInContext(`
      var source = { date: new Date(0), map: new Map([['x', { value: 1 }]]), set: new Set([2]) };
      source.self = source;
      var copy = structuredClone(source);
      copy !== source && copy.self === copy && copy.date instanceof Date
        && copy.date.getTime() === 0 && copy.map.get('x') !== source.map.get('x')
        && copy.map.get('x').value === 1 && copy.set.has(2);
    `, context)).toBe(true);
    expect(() => runInContext('structuredClone({ callback: function () {} })', context)).toThrow();
  });

  it('retains available native APIs', () => {
    const context = createContext({ setTimeout, clearTimeout, structuredClone, URL });
    context.window = context;
    runInContext(`var originals = [Object.hasOwn, Array.prototype.at, String.prototype.at, String.prototype.replaceAll, structuredClone, URL.canParse];`, context);
    runInContext(MOBILE_MERMAID_JS, context, { timeout: 10_000 });
    expect(runInContext(`originals.every((value, index) => value === [Object.hasOwn, Array.prototype.at, String.prototype.at, String.prototype.replaceAll, structuredClone, URL.canParse][index])`, context)).toBe(true);
  });
});
