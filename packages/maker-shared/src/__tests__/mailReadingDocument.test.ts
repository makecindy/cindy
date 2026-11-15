import { describe, expect, it } from 'vitest';
import { mailInlineDocument, mailReadingDocument } from '../mailTextEdit';

describe('mail reading document', () => {
  it('preserves authored text nodes, responsive CSS and colors without editor whitespace rules', () => {
    const source = '<html><head><style>@media(max-width:600px){.card{padding:10px}}</style></head><body style="background:#f99a3c"><table><tr><td style="text-align:left"><p style="margin:0;line-height:28px">\n    Alex\n  </p><p>First<br>Second</p></td></tr></table></body></html>';
    const reading = mailReadingDocument(source);
    expect(reading).toContain('<p style="margin:0;line-height:28px">\n    Alex\n  </p>');
    expect(reading).toContain('<p>First<br>Second</p>');
    expect(reading).toContain('@media(max-width:600px){.card{padding:10px}}');
    expect(reading).toContain('background:#f99a3c');
    expect(reading).not.toMatch(/data-cindy-mail-run|pre-wrap|font:16px\/1.6/);
    expect(mailInlineDocument(source)).toContain('data-cindy-mail-run');
  });

  it('retains the same sandbox and deferred image consent in the reader and editor', () => {
    const image = { cid: 'logo', url: 'data:image/png;base64,YQ==' };
    const source = '<img src="cid:logo"><img src="https://example.test/image" onerror="evil()"><style>p{background:url(https://example.test/track)}</style><script>evil()</script><iframe src="https://example.test"></iframe><img src="file:///private/photo.png">';
    for (const render of [mailReadingDocument, mailInlineDocument]) {
      const blocked = render(source, [image]);
      expect(blocked).toContain('src="data:image/png;base64,YQ=="');
      expect(blocked).not.toContain('https://example.test/image');
      const allowed = render(source, [image], true);
      expect(allowed).toContain('data-cindy-mail-external-src="https://example.test/image"');
      expect(allowed).not.toContain(' src="https://example.test/image"');
      expect(allowed).toContain('referrerpolicy="no-referrer"');
      expect(allowed).toContain("script-src 'none'");
      expect(allowed).toContain("default-src 'none'");
      expect(allowed).not.toMatch(/evil|iframe|file:|url\(/);
    }
  });
});
