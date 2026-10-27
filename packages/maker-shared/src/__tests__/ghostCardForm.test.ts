import { describe, expect, it } from "vitest";
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { applyMailInlineEdits, hasMailExternalImages, mailInlineDocument, mailInlineRuns, mailTextParagraphs, safeMailDocument } from '../mailTextEdit';
import {
  parseGhostCardForm,
  parseGhostCardFormValues,
  readGhostCardForm,
  omitGhostCardFormPreview,
  trackGhostCardFormDelivery,
  releaseGhostCardFormDelivery,
  pendingGhostCardFormDelivery,
  ghostCardRecipients,
  fitGhostCardRecipients,
  mailCardStatus,
  parseMailCard,
  insertMailImage,
  mailPreviewImages,
  visibleMailAttachments,
} from "../ghostCardForm";

describe("declarative card forms", () => {
  const elements = (node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Element[] => [
    ...('tagName' in node ? [node] : []),
    ...('childNodes' in node ? node.childNodes.flatMap(elements) : []),
  ];
  // Both clients use this preview document. Rendering untrusted mail must not
  // contact a sender's tracking endpoint, nor rewrite the outgoing source.
  it('blocks remote images and CSS fetches while retaining managed inline images', () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const source = '<p>Hello</p><img src="https://tracker.example.test/open" srcset="https://tracker.example.test/retina 2x"><img src="cid:photo"><img src="data:image/png;base64,YQ=="><div style="background:url(https://tracker.example.test/bg)">Footer</div>';
    const nodes = elements(parse(mailInlineDocument(source, [{ cid: 'photo', url }])));
    const images = nodes.filter(n => n.tagName === 'img');
    expect(images.map(n => n.attrs.find(a => a.name === 'src')?.value)).toEqual([undefined, url, 'data:image/png;base64,YQ==']);
    expect(images.some(n => n.attrs.some(a => a.name === 'srcset'))).toBe(false);
    expect(nodes.find(n => n.tagName === 'div')?.attrs.find(a => a.name === 'style')?.value).toBe('background:none');
    const csp = nodes.find(n => n.tagName === 'meta' && n.attrs.some(a => a.name === 'http-equiv' && a.value === 'Content-Security-Policy'))!;
    expect(csp.attrs.find(a => a.name === 'content')?.value.split(';').map(s => s.trim())).toContain('img-src data: cindy-media:');
    expect(applyMailInlineEdits(source, {})!.html).toBe(source);
  });
  // Unit: opt-in adds only validated image requests; it must not enable scripts,
  // CSS tracking, forged attributes or local-file access in either client.
  it('allows external image sources only with explicit consent while retaining the mail sandbox', () => {
    const source = '<img src="https://images.example.test/a" onerror="evil()" referrerpolicy="unsafe-url"><img src="http://images.example.test/b"><img src="//images.example.test/c"><img src="file:///private/photo.png"><img src="javascript:evil()"><img src="https://user:password@images.example.test/d"><script>evil()</script><style>@import "https://images.example.test/style";p{background:url(https://images.example.test/bg)}</style>';
    expect(hasMailExternalImages(source)).toBe(true);
    expect(hasMailExternalImages('<template><img src="https://images.example.test/a"></template><img src="cid:photo">')).toBe(false);
    const nodes = elements(parse(mailInlineDocument(source, [], true)));
    const images = nodes.filter(n => n.tagName === 'img');
    expect(images.every(n => !n.attrs.some(a => a.name === 'src'))).toBe(true);
    expect(images.map(n => n.attrs.find(a => a.name === 'data-cindy-mail-external-src')?.value)).toEqual([
      'https://images.example.test/a', 'http://images.example.test/b', 'https://images.example.test/c', undefined, undefined, undefined,
    ]);
    expect(images.slice(0, 3).every(n => n.attrs.some(a => a.name === 'referrerpolicy' && a.value === 'no-referrer'))).toBe(true);
    const csp = nodes.find(n => n.tagName === 'meta' && n.attrs.some(a => a.name === 'http-equiv'))!.attrs.find(a => a.name === 'content')!.value;
    expect(csp).toContain('img-src data: cindy-media: https: http:');
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(mailInlineDocument(source, [], true)).not.toMatch(/evil|file:|@import|url\(|unsafe-url|password/);
    expect(applyMailInlineEdits(source, {})!.html).toBe(source);
  });
  it('omits legacy form nodes without joining malformed markup into executable tags', () => {
    const form = '<div data-ghost-form="[{&quot;name&quot;:&quot;body&quot;,&quot;label&quot;:&quot;Body&quot;,&quot;value&quot;:&quot;text&quot;}]"><div>Preview</div></div>';
    for (const split of ['<scr<style></style>ipt>alert(1)</script>', '<scr<script></script>ipt>alert(1)</script>']) {
      const result = omitGhostCardFormPreview(split + form + '<p>Sender</p>');
      const nodes = elements(parse(result));
      expect(nodes.some(n => ['script', 'style'].includes(n.tagName))).toBe(false);
      expect(nodes.some(n => n.attrs.some(a => a.name === 'data-ghost-form'))).toBe(false);
      expect(result).toContain('<p>Sender</p>');
    }
  });
  // A failed view must not poison a task after remount; live edits still gate chat.
  it('retires a failed editor while preserving in-flight and replacement deliveries', async () => {
    let finish!: (ok: boolean) => void;
    trackGhostCardFormDelivery('retiring', 'old', new Promise(resolve => { finish = resolve; }));
    releaseGhostCardFormDelivery('retiring', 'old');
    expect(pendingGhostCardFormDelivery('retiring')).toBeDefined();
    finish(false);
    await Promise.resolve(); await Promise.resolve();
    expect(pendingGhostCardFormDelivery('retiring')).toBeUndefined();
    trackGhostCardFormDelivery('retiring', 'new', Promise.resolve(false));
    await Promise.resolve();
    releaseGhostCardFormDelivery('retiring', 'new');
    trackGhostCardFormDelivery('retiring', 'new', Promise.resolve(false));
    await Promise.resolve();
    expect(await pendingGhostCardFormDelivery('retiring')).toBe(false);
    releaseGhostCardFormDelivery('retiring', 'new');
    await Promise.resolve();
    expect(pendingGhostCardFormDelivery('retiring')).toBeUndefined();
  });
  it('keeps preheaders hidden and out of editable text without changing outgoing HTML', () => {
    const source = '<div hidden>Private preheader</div><p>Hello</p>';
    expect(safeMailDocument(source, true)).toContain('<div hidden="">Private preheader</div>');
    expect(mailInlineRuns(source).map(r => r.text)).toEqual(['Hello']);
    expect(applyMailInlineEdits(source, { 0: 'Hi' })!.html).toBe('<div hidden>Private preheader</div><p>Hi</p>');
  });
  // Shared presentation contract: inline images disappear only from the list,
  // never from the outgoing MIME data. Text, comments and CID prefixes do not count.
  it('lists ordinary attachments and restores images when their last HTML reference is removed', () => {
    const files = [
      { key: 'body', filename: 'body.png', contentId: '<body>', mimeType: 'image/png' },
      { key: 'quote', filename: 'quote.jpg', contentId: 'quote', mimeType: 'image/jpeg' },
      { key: 'unused', filename: 'unused.png', contentId: 'unused', mimeType: 'image/png' },
      { key: 'pdf', filename: 'notes.pdf', mimeType: 'application/pdf' },
    ];
    const values = { attachmentItems: JSON.stringify(files), bodyHtml: '<img src="cid:body"><!-- <img src="cid:unused"> --><p>cid:unused</p><img src="cid:unused-extra">', quoteHtml: "<IMG SRC='cid:quote'>" };
    expect(visibleMailAttachments(values).map(f => f.key)).toEqual(['unused', 'pdf']);
    expect(JSON.parse(values.attachmentItems)).toEqual(files);
    expect(visibleMailAttachments({ ...values, bodyHtml: '' }).map(f => f.key)).toEqual(['body', 'unused', 'pdf']);
    expect(visibleMailAttachments({ ...values, bodyHtml: '', quoteHtml: '' })).toEqual(files);
  });
  // Unit regression through insertMailImage: attachment-list coverage already checked CID
  // prefixes, but insertion still used substring matching. `cid:photo-large` plus a `photo`
  // attachment was the minimal input that incorrectly left the user's draft unchanged.
  it('inserts an image when another inline CID only shares its prefix', () => {
    const values = { bodyHtml: '<img src="cid:photo-large">', quoteHtml: '', attachmentItems: JSON.stringify([
      { key: 'photo', filename: 'photo.png', mimeType: 'image/png', contentId: 'photo' },
    ]) };
    const next = insertMailImage(values, 'attachmentItems', 'photo');
    expect(next.bodyHtml).toContain('<img src="cid:photo-large">');
    expect(next.bodyHtml).toContain('<img src="cid:photo" alt="photo.png"');
  });
  it('inserts existing image bytes with an unused CID and keeps preview addresses out of the authored HTML', () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const values = { bodyHtml: '<html><head><style>img{width:200px}</style></head><body><p>Hi</p></body></html>', attachmentItems: JSON.stringify([
      { key: 'first', filename: 'first.png', mimeType: 'image/png', contentId: 'image-1@cindy.local' },
      { key: 'next', filename: '<next>.png', mimeType: 'image/png', previewUrl: url },
      { key: 'pdf', filename: 'notes.pdf', mimeType: 'application/pdf' },
    ]) };
    const next = insertMailImage(values, 'attachmentItems', 'next');
    expect(next.bodyHtml).toContain('src="cid:image-2@cindy.local" alt="&lt;next&gt;.png"');
    expect(next.bodyHtml).toContain('<style>img{width:200px}</style>');
    expect(next.bodyHtml).not.toContain('cindy-media:');
    expect(mailPreviewImages(next)).toEqual([{ cid: 'image-2@cindy.local', url }]);
    expect(visibleMailAttachments(next).map(f => f.key)).toEqual(['first', 'pdf']);
    expect(insertMailImage(next, 'attachmentItems', 'next')).toBe(next);
    expect(insertMailImage(values, 'attachmentItems', 'pdf')).toBe(values);
  });
  // User correction: simple typing must preserve HTML, not flatten it. Unit
  // tests cover the shared production text patcher; previous coverage was preview-only.
  it('edits paragraphs and line breaks while preserving CSS, inline formatting, links and CID images', () => {
    const html = '<!doctype html><html><head><style>p{color:red}</style></head><body><p>Hello <b>Cherry</b> &amp; Dash</p><p><a href="https://example.test">Link</a><br>Next</p><img src="cid:card"></body></html>';
    expect(mailTextParagraphs(html).map(p => p.text)).toEqual(['Hello Cherry & Dash', 'Link\nNext']);
    expect(applyMailInlineEdits(html, {})!.html).toBe(html);
    expect(mailInlineRuns(html).map(r => r.text)).toEqual(['Hello ', 'Cherry', ' & Dash', 'Link', '\n', 'Next']);
    const updated = applyMailInlineEdits(html, { 0: 'Hello Dear ', 5: 'New\nNext' })!;
    expect(updated.html).toContain('<p>Hello Dear <b>Cherry</b> &amp; Dash</p>');
    expect(updated.html).toContain('<a href="https://example.test">Link</a><br>New<br>Next');
    expect(updated.html).toContain('<style>p{color:red}</style>');
    expect(updated.html).toContain('src="cid:card"');
    expect(updated.text).toBe('Hello Dear Cherry & Dash\n\nLink\nNew\nNext');
    expect(applyMailInlineEdits(html, { 1: '' })!.html).toContain('<p>Hello <b></b> &amp; Dash</p>');
    expect(applyMailInlineEdits('<p></p>', { 0: 'New greeting' })!.html).toBe('<p>New greeting</p>');
    const invalid: Record<string, string>[] = [{ '-1': 'x' }, { 999: 'x' }, { 0: 'x'.repeat(16001) }, { 0: '\0' }];
    for (const edits of invalid) expect(applyMailInlineEdits(html, edits)).toBeNull();
  });
  it('treats typed markup as text and allows adding words to an image-only draft', () => {
    const html = '<html><head><title>Not body text</title></head><body><img src="cid:card"></body></html>';
    expect(mailTextParagraphs(html).map(p => p.text)).toEqual(['']);
    const updated = applyMailInlineEdits(html, { 0: 'Hi <script>alert(1)</script>\n你好' })!;
    expect(updated.html).toContain('<img src="cid:card">Hi &lt;script&gt;alert(1)&lt;/script&gt;<br>你好</body>');
    expect(updated.text).toBe('Hi <script>alert(1)</script>\n你好');
  });
  it('creates editable markers only after stripping authored controls and executable content', () => {
    const safe = safeMailDocument('<p contenteditable="true" data-cindy-mail-run="99" onclick="evil()">Hello</p><script>evil()</script><iframe src="x"></iframe><img src="cid:card">', true);
    expect(safe).toContain('<span data-cindy-mail-run="0">Hello</span>');
    expect(safe).not.toMatch(/evil|contenteditable|iframe|run="99"/);
    expect(safeMailDocument('<p></p>', true)).toContain('<p><span data-cindy-mail-run="0"></span></p>');
  });
  it('round-trips a pending send and derives the displayed time without granting send permission', () => {
    const mail = parseMailCard({ accountId: 'a', draftId: 'd', key: '12345678-1234-1234-1234-123456789abc', from: 'self@example.test',
      fields: ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: '' })),
      attachments: [], state: 'sending', status: 'Waiting', sendLabel: 'Send', fromLabel: 'From',
      pendingSend: { deadline: 11000, label: '{seconds} 秒后发送', cancelLabel: '撤销', sendNowLabel: '立即发送' } });
    expect(mail).not.toBeNull();
    expect(mailCardStatus(mail!, 1000)).toBe('10 秒后发送');
    expect(mailCardStatus(mail!, 10001)).toBe('1 秒后发送');
    expect(mailCardStatus(mail!, 12000)).toBe('0 秒后发送');
    expect(parseMailCard({ ...mail, state: 'sent' })).toBeNull();
    expect(parseMailCard({ ...mail, pendingSend: { ...mail!.pendingSend, deadline: 'soon' } })).toBeNull();
  });
  // Width-based overflow must not omit a recipient or split a quoted display
  // name into multiple people. Pure unit coverage shared by both renderers.
  it("packs measured names only when needed and preserves quoted addresses", () => {
    const addresses =
      '"Smith, Jane" <jane@example.test>, 李明 <li@example.test>';
    expect(ghostCardRecipients(addresses)).toEqual([
      { address: '"Smith, Jane" <jane@example.test>', label: "Smith, Jane" },
      { address: "李明 <li@example.test>", label: "李明" },
    ]);
    const groups = [
      { label: 30, chips: [50, 100, 50], more: [12, 20, 20, 20] },
      { label: 20, chips: [40], more: [12, 20] },
    ];
    expect(fitGhostCardRecipients(500, groups)).toEqual([3, 1]);
    expect(fitGhostCardRecipients(190, groups)).toEqual([1, 1]);
    // If only one name fits, keep the primary recipient rather than a Cc name.
    expect(fitGhostCardRecipients(160, groups)).toEqual([1, 0]);
    expect(fitGhostCardRecipients(100, groups)).toEqual([0, 0]);
    const field = {
      name: "to",
      label: "To",
      value: addresses,
      kind: "recipients",
    };
    expect(parseGhostCardForm([field])?.[0]).toEqual(field);
    expect(
      parseGhostCardForm([{ ...field, kind: "future" }])?.[0].kind,
    ).toBeUndefined();
  });
  it("holds chat behind edits in flight and fails closed until a new delivery succeeds", async () => {
    let resolve!: (ok: boolean) => void;
    trackGhostCardFormDelivery(
      "task",
      "card",
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = pendingGhostCardFormDelivery("task")!;
    expect(pendingGhostCardFormDelivery("other")).toBeUndefined();
    resolve(false);
    expect(await pending).toBe(false);
    expect(await pendingGhostCardFormDelivery("task")).toBe(false);
    trackGhostCardFormDelivery("task", "card", Promise.resolve(true));
    expect(await pendingGhostCardFormDelivery("task")).toBe(true);
    expect(pendingGhostCardFormDelivery("task")).toBeUndefined();
  });
  it("round-trips text, quotes, newlines and markup as inert data", () => {
    const fields = [
      {
        name: "body",
        label: "Message",
        value: '<script> & "\n正文',
        multiline: true,
      },
    ];
    const encoded = JSON.stringify(fields)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    expect(
      readGhostCardForm(`<div data-ghost-form="${encoded}">Preview</div>`),
    ).toEqual(fields);
    expect(
      omitGhostCardFormPreview(
        `<div data-ghost-form="${encoded}"><div>Nested preview</div></div><p>Sender</p>`,
      ),
    ).toBe("<p>Sender</p>");
    expect(parseGhostCardFormValues({ body: "  exact\n" })).toEqual({
      body: "  exact\n",
    });
  });
  it("rejects duplicates, prototype keys, oversized and unsupported fields", () => {
    const field = { name: "body", label: "Message", value: "text" };
    for (const fields of [
      [field, field],
      [{ ...field, name: "__proto__" }],
      [{ ...field, value: "x".repeat(16001) }],
      [{ ...field, multiline: "yes" }],
    ])
      expect(parseGhostCardForm(fields)).toBeNull();
    for (const values of [
      [],
      {},
      { body: 1 },
      { constructor: "x" },
      { body: "x".repeat(16001) },
    ])
      expect(parseGhostCardFormValues(values)).toBeNull();
    expect(readGhostCardForm('<div data-ghost-form="[]"></div>')).toBeNull();
  });
});
