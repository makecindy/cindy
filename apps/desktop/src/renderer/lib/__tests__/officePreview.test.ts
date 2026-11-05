// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

import {
  OFFICE_PREVIEW_LIMIT,
  isOfficePreviewSupported,
  officePreviewKind,
  parseOfficeDocument,
  sanitizeOfficeHtml,
} from '../officePreview';

type ReadBytesStub = (params: {
  filePath: string;
  maxSize?: number;
}) => Promise<{ bytes: Uint8Array; size: number }>;

function stubReadFileBytes(stub: ReadBytesStub): void {
  vi.stubGlobal('window', { electronAPI: { readFileBytes: stub } });
}

/** 最小可用 docx(ZIP 包:content types + rels + styles + document)。 */
/** 文本入参按 XML 语义写(&lt; 已转义),mammoth 解出后应保持 HTML 转义。 */
async function buildDocx(xmlEscapedText: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  );
  zip.file(
    'word/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>' +
      xmlEscapedText +
      '</w:t></w:r></w:p></w:body>' +
      '</w:document>',
  );
  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return new Uint8Array(arrayBuffer);
}

function buildXlsx(bookType: 'xlsx' | 'biff8' = 'xlsx'): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['名称', '数量'],
      ['扳手', 3],
    ]),
    '汇总',
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['<b>bold</b>']]), 'Esc');
  const out = XLSX.write(wb, { type: 'array', bookType });
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sanitizeOfficeHtml', () => {
  it('keeps document layout and embedded raster images without active content', () => {
    const html = sanitizeOfficeHtml(
      '<h1>Title</h1><table><tr><td colspan="2">Value</td></tr></table>' +
        '<img src="data:image/png;base64,aGVsbG8=" alt="embedded">' +
        '<a href="javascript:alert(1)">Link text</a><script>alert(1)</script>' +
        '<img src="https://tracker.example/image" onerror="alert(1)">' +
        '<img src="xdt-file:///private/file.png">' +
        '<img src="data:image/svg+xml;base64,PHN2Zz4=">' +
        '<svg onload="alert(1)"></svg><iframe src="https://example.com"></iframe>',
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(root.textContent).toContain('Link text');
    expect(root.querySelector('a, script, svg, iframe, [onerror], [onload]')).toBeNull();
  });
});

describe('officePreviewKind / isOfficePreviewSupported', () => {
  it('routes by extension, case-insensitive, across path separators', () => {
    expect(officePreviewKind('/tmp/report.docx')).toBe('word');
    expect(officePreviewKind('C:\\docs\\表.DOCX')).toBe('word');
    expect(officePreviewKind('/tmp/data.xlsx')).toBe('sheet');
    expect(officePreviewKind('/tmp/old.xls')).toBe('sheet');
    expect(isOfficePreviewSupported('/tmp/report.docx')).toBe(true);
    expect(isOfficePreviewSupported('/tmp/legacy.doc')).toBe(false);
    expect(isOfficePreviewSupported('/tmp/deck.pptx')).toBe(false);
    expect(isOfficePreviewSupported('/tmp/notes.txt')).toBe(false);
    expect(isOfficePreviewSupported('/tmp/noext')).toBe(false);
    expect(isOfficePreviewSupported('/tmp/.docx')).toBe(false);
  });
});

describe('parseOfficeDocument', () => {
  it('rejects prefixed DOCX rather than allowing tolerant ZIP parsing to bypass expansion checks', async () => {
    // PR #8810 security review: JSZip accepts a leading NUL before a valid ZIP.
    // A tiny valid document proves the bypass without inflating a bomb in tests.
    const zip = await buildDocx('Must not reach the unchecked parser');
    const bytes = new Uint8Array(zip.length + 1);
    bytes.set(zip, 1);
    stubReadFileBytes(async () => ({ bytes, size: bytes.length }));
    await expect(parseOfficeDocument('/tmp/prefixed.docx')).rejects.toThrow('Invalid Office archive');
  });

  it('rejects a compressed archive exceeding the actual expansion budget', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', 'x'.repeat(20 * 1024 * 1024 + 1));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    // Lie in both size headers: the cap must count actual inflate output.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(22, 1, true);
    for (let offset = 0; offset + 46 <= bytes.length; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 1, true);
    }
    stubReadFileBytes(async () => ({ bytes, size: bytes.length }));
    await expect(parseOfficeDocument('/tmp/bomb.docx')).rejects.toThrow('exceeds preview capacity');
  });

  it('counts repeated shared string output before generating worksheet HTML', async () => {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(Array.from({ length: 20 }, () => ['x'.repeat(20_000)]));
    for (let row = 1; row <= 20; row++) sheet[`A${row}`].z = ';;;';
    XLSX.utils.book_append_sheet(wb, sheet, 'Repeated');
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: 'array', bookType: 'xlsx', bookSST: true }),
    );
    stubReadFileBytes(async () => ({ bytes, size: bytes.length }));
    await expect(parseOfficeDocument('/tmp/repeated.xlsx')).rejects.toThrow(
      'output exceeds preview capacity',
    );
  });

  it('rejects unsupported office extensions', async () => {
    await expect(parseOfficeDocument('/tmp/deck.pptx')).rejects.toThrow('unsupported office file');
  });

  it('passes the preview size cap to readFileBytes', async () => {
    const seen: Array<number | undefined> = [];
    const bytes = buildXlsx();
    stubReadFileBytes(async (params) => {
      seen.push(params.maxSize);
      return { bytes, size: bytes.byteLength };
    });
    await parseOfficeDocument('/tmp/a.xlsx');
    expect(seen[0]).toBe(OFFICE_PREVIEW_LIMIT);
  });

  it.each([
    ['xlsx', 'xlsx'],
    ['xls', 'biff8'],
  ] as const)('parses %s into named sheet tables and escapes cell text', async (ext, bookType) => {
    const bytes = buildXlsx(bookType);
    stubReadFileBytes(async () => ({ bytes, size: bytes.byteLength }));
    const doc = await parseOfficeDocument(`/tmp/inventory.${ext}`);
    expect(doc.kind).toBe('sheet');
    if (doc.kind !== 'sheet') return;
    expect(doc.sheets.map((s) => s.name)).toEqual(['汇总', 'Esc']);
    expect(doc.sheets[0].html).toContain('扳手');
    expect(doc.sheets[1].html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(doc.sheets[1].html).not.toContain('<b>bold</b>');
  });

  it('decodes a renamed remote cache using the original extension without reading the remote path', async () => {
    const bytes = buildXlsx();
    const read = vi.fn<ReadBytesStub>(async () => ({ bytes, size: bytes.byteLength }));
    stubReadFileBytes(read);
    const doc = await parseOfficeDocument('/cache/authorized-copy', '/remote/inventory.xlsx');
    expect(doc.kind).toBe('sheet');
    expect(read.mock.calls[0]?.[0]).toEqual({
      filePath: '/cache/authorized-copy',
      maxSize: OFFICE_PREVIEW_LIMIT,
    });
  });

  it('parses docx via mammoth and keeps text escaped', async () => {
    const bytes = await buildDocx('Hello &lt;b&gt;Office&lt;/b&gt;');
    stubReadFileBytes(async () => ({ bytes, size: bytes.byteLength }));
    const doc = await parseOfficeDocument('/tmp/报告.docx');
    expect(doc.kind).toBe('word');
    if (doc.kind !== 'word') return;
    expect(doc.html).toContain('Hello');
    expect(doc.html).toContain('&lt;b&gt;Office&lt;/b&gt;');
    expect(doc.html).not.toContain('<b>Office</b>');
  });

  it('rejects a tiny xlsx declaring an enormous cell range before rendering it', async () => {
    const zip = await JSZip.loadAsync(buildXlsx());
    const path = 'xl/worksheets/sheet1.xml';
    const xml = await zip.file(path)!.async('string');
    zip.file(path, xml.replace(/<dimension ref="[^"]*"\s*\/>/, '<dimension ref="A1:XFD1048576"/>'));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    stubReadFileBytes(async () => ({ bytes, size: bytes.byteLength }));
    await expect(parseOfficeDocument('/tmp/oversized-range.xlsx')).rejects.toThrow(
      'exceeds preview capacity',
    );
  });

  it('rejects excessive merge traversal even when the cell range is within the limit', async () => {
    const zip = await JSZip.loadAsync(buildXlsx());
    const path = 'xl/worksheets/sheet1.xml';
    const xml = await zip.file(path)!.async('string');
    const merges =
      '<mergeCells count="100"><mergeCell ref="A1:A1"/>'.replace(
        '<mergeCell ref="A1:A1"/>',
        '<mergeCell ref="A1:A1"/>'.repeat(100),
      ) + '</mergeCells>';
    zip.file(
      path,
      xml
        .replace(/<dimension ref="[^"]*"\s*\/>/, '<dimension ref="A1:A100000"/>')
        .replace('</worksheet>', merges + '</worksheet>'),
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    stubReadFileBytes(async () => ({ bytes, size: bytes.byteLength }));
    await expect(parseOfficeDocument('/tmp/excessive-merges.xlsx')).rejects.toThrow(
      'merge complexity',
    );
  });
});
