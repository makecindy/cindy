import { describe, it, expect } from 'vitest';
import { extractPayloadToolResultMedia as media, extractPayloadToolResultFiles as files, extractPayloadToolCardIds as cards } from '../payloadSummary.js';
import { hasVisibleHistoryResult } from '../historyViewProjection.js';
const blob = (ext: string) => `cindy-media://blobs/${'a'.repeat(64)}.${ext}`;

describe('portable plugin results', () => {
  it.each(["'", '"'])('recognizes triple-quoted source strings using %s', (quote) => {
    const delimiter = quote.repeat(3);
    const url = 'xdt-file:///tmp/triple.pdf';
    for (const body of [url, 'Open\n' + quote + 'example' + quote.repeat(2) + '\n' + url,
      'Escaped ' + '\\' + delimiter + ' Open ' + url]) {
      for (const prefix of ['', 'r', 'f']) {
        const literal = prefix + delimiter + body + delimiter;
        for (const source of ['path = ' + literal, 'path = "prefix" + ' + literal + ' + "suffix"']) {
          expect(files(source), source).toEqual([]);
          expect(files(JSON.stringify({ text: source })), source).toEqual([]);
          expect(files(source + '\nSaved "' + url + '"')).toEqual([{ url, title: 'triple.pdf' }]);
          expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Triple' }] })))
            .toEqual([{ url, title: 'Triple' }]);
        }
        expect(files('path = ' + prefix + delimiter + body)).toEqual([]);
      }
    }
  });
  it('preserves hash-prefixed Markdown deliveries and hashes in legacy file names', () => {
    const url = 'xdt-file:///tmp/report#final.pdf';
    for (const text of ['# fixture: ' + url, '## Report: ' + url, '# [report](' + url + ')']) {
      expect(files(text)).toEqual([{ url, title: 'report#final.pdf' }]);
      expect(files(JSON.stringify({ text }))).toEqual([{ url, title: 'report#final.pdf' }]);
    }
  });
  it.each(["'", '"', String.fromCharCode(96)])('keeps concatenated source literals out of delivered files: %s', (quote) => {
    const url = 'xdt-file:///tmp/concatenated.pdf';
    const literal = quote + url + quote;
    for (const source of [
      'const path = "prefix" + ' + literal,
      'const path = "prefix" + /* continuation */\n  ' + literal,
      'return "prefix" + " middle " + ' + literal,
      'const path = "prefix"+' + quote + 'Open ' + url + quote,
    ]) {
      expect(files(source), source).toEqual([]);
      expect(files(JSON.stringify({ text: source })), source).toEqual([]);
      expect(files(source + '\nSaved ' + literal)).toEqual([{ url, title: 'concatenated.pdf' }]);
      expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Concatenated' }] })))
        .toEqual([{ url, title: 'Concatenated' }]);
    }
    const next = 'xdt-file:///tmp/next.pdf';
    expect(files('Saved ' + literal + ' + ' + quote + next + quote)).toEqual([
      { url, title: 'concatenated.pdf' }, { url: next, title: 'next.pdf' },
    ]);
    expect(files('Saved "prefix" + ' + literal)).toEqual([{ url, title: 'concatenated.pdf' }]);
  });
  it.each(['r', 'R', 'f', 'F', 'b', 'u', 'br', 'rb', 'fr', 'rf', '@', '$', '@$', '$@'])('recognizes source literals with prefix %s', (prefix) => {
    const url = 'xdt-file:///tmp/prefixed.pdf';
    for (const quote of (prefix.includes('@') || prefix.includes('$') ? ['"'] : ["'", '"'])) {
      for (const content of [url, 'Open ' + url]) {
        const literal = prefix + quote + content + quote;
        for (const source of ['path = ' + literal, 'return ' + literal, 'open(' + literal + ')', 'paths = [' + literal + ']', 'path = "prefix" + ' + literal]) {
          expect(files(source), source).toEqual([]);
          expect(files(JSON.stringify({ text: source })), source).toEqual([]);
          expect(files(source + '\nSaved "' + url + '"')).toEqual([{ url, title: 'prefixed.pdf' }]);
          expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Prefixed' }] })))
            .toEqual([{ url, title: 'Prefixed' }]);
        }
      }
    }
    // A language prefix alone must not turn ordinary output into source code.
    expect(files('Saved ' + prefix + '"' + url + '"')).toEqual([{ url, title: 'prefixed.pdf' }]);
  });
  it.each([
    '// fixture: xdt-file:///tmp/example.pdf',
    'const enabled = true; // fixture: xdt-file:///tmp/example.pdf',
    '/* fixture: xdt-file:///tmp/example.pdf */',
    '/* example\n * xdt-file:///tmp/example.pdf\n */',
    '// fixture: "xdt-file:///tmp/example.pdf"',
  ])('does not extract file deliveries from source comments: %s', (source) => {
    const url = 'xdt-file:///tmp/actual.pdf';
    expect(files(source)).toEqual([]);
    expect(files(JSON.stringify({ text: source }))).toEqual([]);
    expect(files(source + '\nSaved [report](' + url + ')')).toEqual([{ url, title: 'actual.pdf' }]);
    expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Actual' }] })))
      .toEqual([{ url, title: 'Actual' }]);
  });
  it.each(['xdt-file:///tmp/a//report.pdf', 'xdt-file:///tmp/a/*report.pdf'])('does not treat URL path characters as comments: %s', (url) => {
    const next = 'xdt-file:///tmp/next.pdf';
    const expected = [{ url, title: url.split('/').pop() }, { url: next, title: 'next.pdf' }];
    expect(files('Saved ' + url + ' and ' + next)).toEqual(expected);
    expect(files('[first](' + url + ') [next](' + next + ')')).toEqual(expected);
    expect(files(JSON.stringify({ text: 'Saved ' + url + ' and ' + next }))).toEqual(expected);
  });
  it.each(["'", '"', String.fromCharCode(96)])('recognizes arrow-function source literals quoted with %s', (quote) => {
    const url = 'xdt-file:///tmp/callback.pdf';
    for (const content of [url, 'Open ' + url]) {
      const literal = quote + content + quote;
      for (const source of [
        'const paths = names.map(() => ' + literal + ')',
        'const path = () => ' + literal,
        'const path = async () => /* example */\n  ' + literal,
      ]) {
        expect(files(source), source).toEqual([]);
        expect(files(JSON.stringify({ text: source })), source).toEqual([]);
        expect(files(source + '\nSaved "' + url + '"')).toEqual([{ url, title: 'callback.pdf' }]);
        expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Callback' }] })))
          .toEqual([{ url, title: 'Callback' }]);
      }
    }
    // A Markdown quote marker alone is not the arrow operator.
    expect(files('> ' + quote + url + quote)).toEqual([{ url, title: 'callback.pdf' }]);
  });
  it.each(["'", '"', String.fromCharCode(96)])('handles long escaped source literals ending in a backslash: %s', (quote) => {
    const source = 'const message = ' + quote + ('\\' + quote).repeat(5000)
      + ' Open xdt-file:///tmp/fixture.pdf' + '\\';
    expect(files(source)).toEqual([]);
    expect(files(JSON.stringify({ text: source }))).toEqual([]);
  });
  it('handles repeated unterminated block-comment openers without hiding earlier real files', () => {
    const url = 'xdt-file:///tmp/report.pdf';
    const source = 'Saved [report](' + url + ')\n/*' + 'a/*'.repeat(5000);
    expect(files(source)).toEqual([{ url, title: 'report.pdf' }]);
  });
  it.each(["'", '"', String.fromCharCode(96)])('ignores URLs anywhere inside source literals quoted with %s', (quote) => {
    const url = 'xdt-file:///tmp/fixture.pdf';
    const body = 'Open ' + url + ' or [report](xdt-file://open?path=%2Ftmp%2Fother.pdf)';
    const literal = quote + body + quote;
    for (const source of [
      'const message = ' + literal,
      'return ' + literal,
      'notify(' + literal + ')',
      'const messages = [' + literal + ', /* next */ ' + literal + ']',
      'const message = { text: ' + literal + ' }',
      'const message = enabled ? ' + literal + ' : undefined',
      'const message = fallback || ' + literal,
      'const message = ' + quote + 'Open \\' + quote + 'report\\' + quote + ' at ' + url + quote,
    ]) {
      expect(files(source), source).toEqual([]);
      expect(files(JSON.stringify({ content: [{ type: 'text', text: source }] })), source).toEqual([]);
      expect(files(source + '\nSaved [report](' + url + ')'), source).toEqual([{ url, title: 'fixture.pdf' }]);
      expect(files(JSON.stringify({ text: source, _xdt_model_files: [{ url, name: 'Report' }] }))).toEqual([{ url, title: 'Report' }]);
    }
  });
  it('keeps URLs in quoted prose and does not inherit source context from a previous statement', () => {
    const a = 'xdt-file:///tmp/first.pdf';
    const b = 'xdt-file:///tmp/second.pdf';
    const expected = [{ url: a, title: 'first.pdf' }, { url: b, title: 'second.pdf' }];
    for (const quote of ["'", '"', String.fromCharCode(96)]) {
      const prose = 'Saved ' + quote + 'first [file](' + a + ')' + quote + ', ' + quote + 'second [file](' + b + ')' + quote;
      expect(files(prose)).toEqual(expected);
      expect(files('const label = "example";\n' + prose)).toEqual(expected);
      expect(files(JSON.stringify({ note: prose }))).toEqual(expected);
    }
    expect(files('Saved "Open ' + a + '", "Open ' + b + '"')).toEqual(expected);
  });
  it('filters multiple URLs in a multiline source template', () => {
    const source = 'const message = ' + String.fromCharCode(96)
      + 'Open\nxdt-file:///tmp/first.pdf\nand xdt-file:///tmp/second.pdf\n'
      + String.fromCharCode(96);
    expect(files(source)).toEqual([]);
  });
  it('preserves the legacy direct-path punctuation alphabet in real references', () => {
    // #4692 accepted these filename characters. Source filtering must not
    // redefine the URL alphabet and silently point to a different file.
    for (const punctuation of "!#$%&'(*+,-.:;=?@[]^_{}~" + String.fromCharCode(96)) {
      const title = 'report' + punctuation + 'final.pdf';
      const url = 'xdt-file:///tmp/' + title;
      const expected = [{ url, title }];
      expect(files('[report](' + url + ')'), title).toEqual(expected);
      expect(files(JSON.stringify({ note: url })), title).toEqual(expected);
      expect(files(JSON.stringify([url])), title).toEqual(expected);
      expect(files(JSON.stringify({ _xdt_model_files: [{ url, name: title }] })), title).toEqual(expected);
    }
  });
  it('reads host ledger images, video and audio and deduplicates declarations', () => {
    const result = JSON.stringify({ xdt_image_urls: [blob('png')], xdt_media_produced: [blob('png'), blob('mp4'), blob('mp3'), blob('glb'), 'file:///secret.png', 'https://external/p.png', 'cindy-media://other/p.png'] });
    expect(media(result).map(({ kind, url }) => [kind, url])).toEqual([['image', blob('png')], ['video', blob('mp4')], ['audio', blob('mp3')]]);
    expect(files(result)).toEqual([{ url: blob('glb'), title: `${'a'.repeat(64)}.glb` }]);
    expect(hasVisibleHistoryResult(result)).toBe(true);
  });
  it('reads the old ghost envelope, including singular fields and card anchors', () => {
    const result = JSON.stringify({ ok: true, result: { xdt_image_url: blob('png'), xdt_video_url: blob('mp4'), xdt_card_id: 'c', xdt_anchor_card_id: 'c' } });
    expect(media(result).map((m) => m.kind)).toEqual(['image', 'video']);
    expect(cards(result)).toEqual(['c']);
    expect(media(JSON.stringify({ arbitrary: { xdt_image_url: blob('png') } }))).toEqual([]);
  });
  it('respects suppression in either envelope and never revives failed nested results', () => {
    for (const result of [
      { ok: true, _xdt_render_image: false, result: { xdt_image_url: blob('png') } },
      { ok: true, result: { _xdt_render_image: false }, xdt_media_produced: [blob('png')] },
      { ok: false, result: { xdt_image_url: blob('png') } },
    ]) expect(media(JSON.stringify(result))).toEqual([]);
  });
  it('retains managed file and model entries without inventing arbitrary local-path access', () => {
    const result = JSON.stringify({ ok: true, result: { _xdt_model_files: [{ url: blob('glb'), name: 'scene.glb' }, { url: 'file:///secret' }], note: 'Saved xdt-file://open?path=%2Ftmp%2Freport.pdf' } });
    expect(files(result)).toEqual([{ url: blob('glb'), title: 'scene.glb' }, { url: 'xdt-file://open?path=%2Ftmp%2Freport.pdf', title: 'report.pdf' }]);
    expect(files('Saved xdt-file://open?path=%2Ftmp%2Freport.pdf')[0].title).toBe('report.pdf');
    expect(hasVisibleHistoryResult(JSON.stringify({ ok: true, result: { xdt_card_id: 'c' } }))).toBe(true);
  });
  it('ignores quoted protocol URLs when a tool prints source code or test fixtures', () => {
    const source = [
      "const urls = ['xdt-file://open?path=%2Ftmp%2Freport.pdf', 'xdt-file://open?path=%2Ftmp%2Findex.html'];",
      "const template = `xdt-file://open?path=${encodeURIComponent(absPath)}`;",
    ].join('\n');
    expect(files(source)).toEqual([]);
    expect(files('Saved xdt-file://open?path=%2Ftmp%2Freport.pdf')).toEqual([
      { url: 'xdt-file://open?path=%2Ftmp%2Freport.pdf', title: 'report.pdf' },
    ]);
  });
  it.each([
    ['xdt-file:///tmp/report.pdf', 'report.pdf'],
    ['xdt-file:///C:/reports/report.pdf', 'report.pdf'],
    ['xdt-file:///tmp/report%20final.pdf', 'report final.pdf'],
    ['xdt-file://open?path=%2Ftmp%2Freport.pdf', 'report.pdf'],
    ['xdt-file://local/?path=C%3A%5Creports%5Creport.pdf', 'report.pdf'],
  ])('retains absolute file references in both supported URL forms: %s', (url, title) => {
    expect(files(`Saved [report](${url})`)).toEqual([{ url, title }]);
    expect(files(JSON.stringify({ _xdt_model_files: [{ url, name: title }] }))).toEqual([{ url, title }]);
    expect(files(JSON.stringify({ xdt_media_produced: [url] }))).toEqual([{ url, title }]);
  });
  it.each([
    ['xdt-file:///tmp/report100%.pdf', 'report100%.pdf'],
    ['xdt-file:///C:/reports/report100%.pdf', 'report100%.pdf'],
    ['xdt-file:///tmp/report%ZZ.pdf', 'report%ZZ.pdf'],
    ['xdt-file:///tmp/report%2', 'report%2'],
    ['xdt-file:///tmp/report%FF.pdf', 'report%FF.pdf'],
    ['xdt-file:///tmp/report%20at100%25.pdf', 'report at100%.pdf'],
    ['xdt-file:///tmp/report%2520.pdf', 'report%20.pdf'],
    ['xdt-file://open?path=%2Ftmp%2Freport100%25.pdf', 'report100%.pdf'],
  ])('retains percent file names and decodes valid escapes once: %s', (url, title) => {
    const expected = [{ url, title }];
    expect(files('[report](' + url + ')')).toEqual(expected);
    expect(files(JSON.stringify({ note: url }))).toEqual(expected);
    expect(files(JSON.stringify({ _xdt_model_files: [{ url }] }))).toEqual(expected);
    expect(files('const path = "' + url + '";')).toEqual([]);
  });
  it.each(['note', 'text', 'output'])('ignores source literals inside JSON %s while retaining real links', (field) => {
    const source = [
      "const a = 'xdt-file://open?path=%2Ftmp%2Ffixture.pdf';",
      'const b = "xdt-file:///tmp/fixture.html";',
      'const c = `xdt-file://open?path=${encodeURIComponent(absPath)}`;',
    ].join('\n');
    const url = 'xdt-file://open?path=%2Ftmp%2Factual.pdf';
    for (const wrap of [
      (text: string) => ({ [field]: text }),
      (text: string) => ({ ok: true, result: { [field]: text } }),
      (text: string) => ({ content: [{ type: 'text', text }] }),
    ]) {
      expect(files(JSON.stringify(wrap(source)))).toEqual([]);
      expect(files(JSON.stringify(wrap(`${source}\nSaved ${url}`)))).toEqual([{ url, title: 'actual.pdf' }]);
    }
  });
  it('keeps explicit file declarations when neighboring JSON text contains source examples', () => {
    const url = 'xdt-file:///tmp/report.pdf';
    expect(files(JSON.stringify({ ok: true, result: {
      _xdt_model_files: [{ url, name: 'Report' }],
      text: `const example = '${url}';`,
    } }))).toEqual([{ url, title: 'Report' }]);
  });
  it.each([
    'xdt-file:///tmp/report[final].pdf',
    'xdt-file://open?path=/tmp/report[final].pdf',
  ])('preserves square brackets in file names: %s', (url) => {
    expect(files('[报告](' + url + ')')).toEqual([{ url, title: 'report[final].pdf' }]);
    expect(files(JSON.stringify({ note: 'Saved ' + url }))).toEqual([{ url, title: 'report[final].pdf' }]);
  });
  it.each([
    'xdt-file:///tmp/report,final.pdf',
    'xdt-file:///C:/reports/report,final.pdf',
    'xdt-file://open?path=/tmp/report,final.pdf',
    'xdt-file://open?path=%2Ftmp%2Freport%2Cfinal.pdf',
  ])('preserves commas in file names without extracting source fixtures: %s', (url) => {
    const expected = [{ url, title: 'report,final.pdf' }];
    expect(files('[报告](' + url + ')')).toEqual(expected);
    expect(files('Saved "' + url + '"')).toEqual(expected);
    expect(files(JSON.stringify({ note: 'Saved ' + url }))).toEqual(expected);
    expect(files(JSON.stringify([url]))).toEqual(expected);
    const source = 'const urls = ["' + url + '", "xdt-file:///tmp/fixture.pdf"];';
    expect(files(source)).toEqual([]);
    expect(files(JSON.stringify({ text: source }))).toEqual([]);
  });
  it('keeps adjacent quoted prose references separate while filtering source arrays', () => {
    const first = "xdt-file:///tmp/O'Brien.pdf";
    const second = 'xdt-file:///tmp/second.pdf';
    const list = "'" + first + "','" + second + "'";
    expect(files('Saved ' + list)).toEqual([
      { url: first, title: "O'Brien.pdf" }, { url: second, title: 'second.pdf' },
    ]);
    expect(files('const urls = [' + list + '];')).toEqual([]);
  });
  it.each(["'", '"', String.fromCharCode(96)])('distinguishes conditional source literals from prose quoted with %s', (quote) => {
    const url = 'xdt-file:///tmp/fixture.pdf';
    const literal = quote + url + quote;
    for (const source of [
      'const path = enabled ? ' + literal + ' : undefined',
      'const path = enabled ? undefined : ' + literal,
      'return enabled ? ' + literal + ' : ' + literal,
      'const path = enabled\n  ? undefined\n  : ' + literal,
    ]) {
      expect(files(source)).toEqual([]);
      expect(files(JSON.stringify({ text: source }))).toEqual([]);
      expect(files(source + '\nFile: ' + literal)).toEqual([{ url, title: 'fixture.pdf' }]);
    }
  });
  it('retains adjacent prose references for every quote style without reviving source arrays', () => {
    const a = 'xdt-file:///tmp/first.pdf';
    const b = 'xdt-file:///tmp/second.pdf';
    for (const left of ["'", '"', String.fromCharCode(96)]) {
      for (const right of ["'", '"', String.fromCharCode(96)]) {
        for (const separator of [',', ', ']) {
          const list = left + a + left + separator + right + b + right;
          const expected = [{ url: a, title: 'first.pdf' }, { url: b, title: 'second.pdf' }];
          expect(files('Saved ' + list), list).toEqual(expected);
          expect(files(JSON.stringify({ note: 'Saved ' + list })), list).toEqual(expected);
          expect(files('const paths = [' + list + '];'), list).toEqual([]);
        }
      }
    }
  });
  it.each(['&&', '||', '??'])('ignores logical-expression source literals after %s', (operator) => {
    const url = 'xdt-file:///tmp/logical.pdf';
    for (const quote of ["'", '"', String.fromCharCode(96)]) {
      const source = 'const path = candidate ' + operator + ' ' + quote + url + quote;
      expect(files(source)).toEqual([]);
      expect(files(JSON.stringify({ text: source }))).toEqual([]);
      expect(files(source + '\nSaved ' + quote + url + quote)).toEqual([{ url, title: 'logical.pdf' }]);
      expect(files('const path = candidate ' + operator + ' /* fallback */ ' + quote + url + quote)).toEqual([]);
    }
  });
  it.each(['/* next file */', '// next file\n', '/* multi\nline "comment" */'])('filters source arrays across comments: %s', (comment) => {
    const a = 'xdt-file:///tmp/first.pdf';
    const b = 'xdt-file:///tmp/second.pdf';
    for (const quote of ["'", '"', String.fromCharCode(96)]) {
      const list = quote + a + quote + ', ' + comment + ' ' + quote + b + quote;
      const source = 'const paths = [ ' + comment + ' ' + list + ' ]';
      expect(files(source)).toEqual([]);
      expect(files(JSON.stringify({ text: source }))).toEqual([]);
      expect(files(source + '\nSaved "' + b + '"')).toEqual([{ url: b, title: 'second.pdf' }]);
      expect(files('Saved ' + list)).toEqual([{ url: a, title: 'first.pdf' }, { url: b, title: 'second.pdf' }]);
    }
  });
  it.each([
    "xdt-file:///tmp/O'Brien.pdf",
    "xdt-file:///C:/reports/O'Brien.pdf",
    "xdt-file://open?path=/tmp/O'Brien.pdf",
    'xdt-file://open?path=%2Ftmp%2FO%27Brien.pdf',
  ])('preserves apostrophes inside file names: %s', (url) => {
    const expected = [{ url, title: "O'Brien.pdf" }];
    expect(files('[report](' + url + ')')).toEqual(expected);
    expect(files('Saved ' + url)).toEqual(expected);
    expect(files(JSON.stringify({ note: 'Saved ' + url }))).toEqual(expected);
    expect(files(JSON.stringify([url]))).toEqual(expected);
    for (const quote of ["'", '"', String.fromCharCode(96)]) {
      expect(files('Saved ' + quote + url + quote)).toEqual(expected);
      expect(files('Saved ' + quote + url + quote + ', done')).toEqual(expected);
    }
    const source = 'const urls = ["' + url + '", "xdt-file:///tmp/fixture.pdf"];';
    expect(files(source)).toEqual([]);
    expect(files(JSON.stringify({ text: source }))).toEqual([]);
  });
  it.each(["'", '"', String.fromCharCode(96)])('keeps prose links quoted with %s without reviving source literals', (quote) => {
    const url = 'xdt-file:///tmp/report.pdf';
    const prose = 'Saved ' + quote + url + quote;
    expect(files(prose)).toEqual([{ url, title: 'report.pdf' }]);
    expect(files('File: ' + quote + url + quote)).toEqual([{ url, title: 'report.pdf' }]);
    expect(files(JSON.stringify({ note: prose }))).toEqual([{ url, title: 'report.pdf' }]);
    for (const source of [
      'const file = ' + quote + url + quote + ';',
      'const urls = [\n  ' + quote + url + quote + ',\n];',
      'open(' + quote + url + quote + ');',
      'const fixture = { url: ' + quote + url + quote + ' };',
      'const fixture = { "url": ' + quote + url + quote + ' };',
      'return ' + quote + url + quote,
    ]) expect(files(source)).toEqual([]);
  });
  it('decodes top-level JSON arrays before identifying source literals', () => {
    const a = 'xdt-file:///tmp/a.pdf';
    const b = 'xdt-file://open?path=%2Ftmp%2Fb.pdf';
    expect(files(JSON.stringify(a))).toEqual([{ url: a, title: 'a.pdf' }]);
    expect(files(JSON.stringify([a, { text: b }, [a]]))).toEqual([
      { url: a, title: 'a.pdf' }, { url: b, title: 'b.pdf' },
    ]);
    expect(files(JSON.stringify(['const file = "' + a + '";']))).toEqual([]);
  });
  it.each([
    'xdt-file://report.pdf',
    'xdt-file://open?path=relative%2Freport.pdf',
    'xdt-file://open?path=${encodeURIComponent(absPath)}',
    'xdt-file://open?path=',
  ])('rejects incomplete or non-absolute file references: %s', (url) => {
    expect(files(`Saved ${url}`)).toEqual([]);
    expect(files(JSON.stringify({ _xdt_model_files: [{ url }] }))).toEqual([]);
  });
});
