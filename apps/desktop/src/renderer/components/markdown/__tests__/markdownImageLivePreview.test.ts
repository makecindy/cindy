/**
 * Unit tests for the pure helpers of `markdownImageLivePreview`:
 *   - `findImageTargets(doc)` — scans for image-only blocks (markdown
 *     `![](...)` lines, HTML `<img>` lines, `<p>`-wrapped blocks, Obsidian
 *     `![[...]]` wiki-link embeds), skipping fenced code so documentation
 *     samples never render as live images.
 *   - `resolveImageSrcToUrl(src, baseDir)` — maps a raw markdown src to the
 *     URL the <img> actually loads (xdt-file:// for local paths).
 *
 * The widget / StateField themselves need a mounted EditorView (jsdom) and
 * mirror the mermaid module's already-proven decoration plumbing, so they're
 * covered manually — same trade-off documented in
 * `markdownMermaidLivePreview.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';

import {
  findImageTargets,
  resolveImageSrcToUrl,
} from '../markdownImageLivePreview';

function docOf(...lines: string[]): Text {
  return Text.of(lines);
}

describe('findImageTargets — markdown form', () => {
  it('returns empty for docs without images', () => {
    expect(findImageTargets(docOf('# title', '', 'plain text'))).toEqual([]);
  });

  it('extracts a standalone image line with alt and src', () => {
    const doc = docOf('# title', '', '![logo](assets/logo.png)', 'after');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      from: doc.line(3).from,
      to: doc.line(3).to,
      align: null,
      images: [{ alt: 'logo', src: 'assets/logo.png', title: '', width: null }],
    });
  });

  it('parses quoted titles and angle-bracket srcs', () => {
    const doc = docOf(
      '![a](img/a.png "hero image")',
      "![b](<img/with space.png> 'alt title')",
    );
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(2);
    expect(targets[0].images[0].title).toBe('hero image');
    expect(targets[1].images[0].src).toBe('img/with space.png');
    expect(targets[1].images[0].title).toBe('alt title');
  });

  it('allows up to 3 leading spaces but not 4 (indented code block)', () => {
    const doc = docOf('   ![ok](a.png)', '    ![raw](b.png)');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].images[0].src).toBe('a.png');
  });

  it('leaves inline images inside paragraphs as raw source', () => {
    const doc = docOf(
      'see ![icon](i.png) inline',
      '![a](a.png) ![b](b.png)',
      '- ![listed](c.png)',
      '> ![quoted](d.png)',
    );
    expect(findImageTargets(doc)).toEqual([]);
  });

  it('skips image examples inside fenced code blocks', () => {
    const doc = docOf(
      '```markdown',
      '![sample](x.png)',
      '<img src="y.png" />',
      '```',
      '![real](y.png)',
    );
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].images[0].src).toBe('y.png');
  });

  it('treats everything after an unterminated fence as raw', () => {
    const doc = docOf('```', '![inside](x.png)');
    expect(findImageTargets(doc)).toEqual([]);
  });

  it('ignores empty srcs', () => {
    expect(findImageTargets(docOf('![alt](<>)'))).toEqual([]);
  });
});

describe('findImageTargets — Obsidian wiki-link form', () => {
  it('extracts a bare wiki-link embed', () => {
    const doc = docOf('before', '![[image.png]]', 'after');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      from: doc.line(2).from,
      to: doc.line(2).to,
      align: null,
      images: [{ src: 'image.png', alt: '', title: '', width: null, height: null }],
    });
  });

  it('resolves a subfolder-relative wiki-link path', () => {
    const doc = docOf('![[subfolder/image.png]]');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].images[0].src).toBe('subfolder/image.png');
  });

  it('parses a width-only size suffix', () => {
    const doc = docOf('![[image.png|300]]');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].images[0]).toMatchObject({
      src: 'image.png',
      width: 300,
      height: null,
    });
  });

  it('parses a width x height size suffix', () => {
    const doc = docOf('![[image.png|300x200]]');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].images[0]).toMatchObject({
      src: 'image.png',
      width: 300,
      height: 200,
    });
  });

  it('allows spaces in the path without angle brackets', () => {
    const doc = docOf('![[Some Image.png]]');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].images[0].src).toBe('Some Image.png');
  });

  it('does not render a plain [[note]] link (no leading !) as an image', () => {
    const doc = docOf('see [[note]] for details');
    expect(findImageTargets(doc)).toEqual([]);
  });

  it('does not render a wiki-link with a non-numeric size suffix', () => {
    const doc = docOf('![[image.png|alt text]]');
    expect(findImageTargets(doc)).toEqual([]);
  });

  it('does not render a wiki-link note embed (no image extension)', () => {
    const doc = docOf('![[Project overview]]');
    expect(findImageTargets(doc)).toEqual([]);
  });

  it('does not render a wiki-link PDF/non-image file embed', () => {
    const doc = docOf('![[manual.pdf]]');
    expect(findImageTargets(doc)).toEqual([]);
  });

  it('accepts a recognized image extension case-insensitively', () => {
    const doc = docOf('![[photo.PNG]]');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].images[0].src).toBe('photo.PNG');
  });

  it('skips wiki-link image examples inside fenced code blocks', () => {
    const doc = docOf('```markdown', '![[sample.png]]', '```', '![[real.png]]');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].images[0].src).toBe('real.png');
  });

  it('leaves an inline wiki-link mid-paragraph as raw source', () => {
    const doc = docOf('see ![[icon.png]] inline');
    expect(findImageTargets(doc)).toEqual([]);
  });
});

describe('findImageTargets — HTML forms', () => {
  it('extracts a bare <img> line with alt / width / height attrs', () => {
    const doc = docOf(
      '<img src="doc/images/shot.webp" alt="Retro Gameplay" width="720" />',
    );
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      align: null,
      images: [
        {
          src: 'doc/images/shot.webp',
          alt: 'Retro Gameplay',
          width: 720,
          height: null,
        },
      ],
    });
  });

  it('extracts a single-line <p align="center">-wrapped image', () => {
    const doc = docOf('<p align="center"><img src="a.png" width="300px"></p>');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].align).toBe('center');
    expect(targets[0].images[0]).toMatchObject({ src: 'a.png', width: 300 });
  });

  it('extracts the multi-line <p> block (README hero-image style)', () => {
    const doc = docOf(
      'before',
      '<p align="center">',
      '  <img src="doc/images/gameplay-screenshot.webp" alt="Flash Party Retro Gameplay" width="720" />',
      '</p>',
      'after',
    );
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      from: doc.line(2).from,
      to: doc.line(4).to,
      align: 'center',
      images: [
        {
          src: 'doc/images/gameplay-screenshot.webp',
          alt: 'Flash Party Retro Gameplay',
          width: 720,
        },
      ],
    });
  });

  it('collects multiple <img> lines inside one <p> block', () => {
    const doc = docOf(
      '<p align="center">',
      '  <img src="a.png" />',
      "  <img src='b.png'>",
      '</p>',
    );
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].images.map((i) => i.src)).toEqual(['a.png', 'b.png']);
  });

  it('leaves a <p> block containing non-image content as raw source', () => {
    const doc = docOf(
      '<p align="center">',
      '  some centered text',
      '</p>',
      '<p align="center">',
      '  <img src="a.png" />',
      'trailing text',
      '</p>',
    );
    expect(findImageTargets(doc)).toEqual([]);
  });

  it('ignores <img> without a src and non-center align values', () => {
    const doc = docOf(
      '<img alt="no src" />',
      '<p align="right"><img src="a.png"></p>',
    );
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    expect(targets[0].align).toBeNull();
  });

  it('never reads dangerous attributes — only src/alt/title/width/height', () => {
    const doc = docOf('<img src="a.png" onerror="alert(1)" class="x" />');
    const targets = findImageTargets(doc);
    expect(targets).toHaveLength(1);
    // The parsed spec carries exactly the whitelisted fields.
    expect(Object.keys(targets[0].images[0]).sort()).toEqual([
      'alt',
      'height',
      'src',
      'title',
      'width',
    ]);
  });
});

describe('resolveImageSrcToUrl', () => {
  it('passes remote / data / privileged URLs through untouched', () => {
    expect(resolveImageSrcToUrl('https://x.com/a.png', '/base')).toBe(
      'https://x.com/a.png',
    );
    expect(resolveImageSrcToUrl('data:image/png;base64,AA==', '/base')).toBe(
      'data:image/png;base64,AA==',
    );
    expect(resolveImageSrcToUrl('xdt-image://cache/a.png', '/base')).toBe(
      'xdt-image://cache/a.png',
    );
  });

  it('routes absolute paths through xdt-file://', () => {
    expect(resolveImageSrcToUrl('/abs/a.png', '')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('/abs/a.png')}`,
    );
    expect(resolveImageSrcToUrl('C:\\imgs\\a.png', '')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('C:\\imgs\\a.png')}`,
    );
  });

  it('joins relative srcs against the base dir, POSIX and Windows style', () => {
    expect(resolveImageSrcToUrl('img/a.png', '/repo/docs')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('/repo/docs/img/a.png')}`,
    );
    // Windows base dir → forward slashes in the src get normalized to \.
    expect(resolveImageSrcToUrl('img/a.png', 'C:\\repo\\docs')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('C:\\repo\\docs\\img\\a.png')}`,
    );
  });

  it('percent-decodes markdown-encoded srcs but survives literal %', () => {
    expect(resolveImageSrcToUrl('my%20img.png', '/base')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('/base/my img.png')}`,
    );
    // decodeURIComponent would throw on the stray % — raw string must win.
    expect(resolveImageSrcToUrl('100%done.png', '/base')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('/base/100%done.png')}`,
    );
  });

  it('unwraps file:// URLs including the Windows leading-slash form', () => {
    expect(resolveImageSrcToUrl('file:///abs/a.png', '/base')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('/abs/a.png')}`,
    );
    expect(resolveImageSrcToUrl('file:///C:/imgs/a.png', '/base')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('C:/imgs/a.png')}`,
    );
  });

  it('joins a wiki-link-style relative path with a literal space and subfolder', () => {
    // Wiki-link parsing hands resolveImageSrcToUrl the raw path as typed
    // (spaces intact, no percent-encoding) — unlike markdown srcs.
    expect(resolveImageSrcToUrl('subfolder/Some Image.png', '/repo/notes')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('/repo/notes/subfolder/Some Image.png')}`,
    );
  });

  it('returns null for empty src or relative src without a base dir', () => {
    expect(resolveImageSrcToUrl('', '/base')).toBeNull();
    expect(resolveImageSrcToUrl('img/a.png', '')).toBeNull();
  });
});
