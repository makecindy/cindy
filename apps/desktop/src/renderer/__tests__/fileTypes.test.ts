/**
 * fileTypes.test.ts
 * ---------------------------------------------------------------------------
 * Unit tests for the file type utilities (F-FI-2).
 */

import { describe, it, expect } from 'vitest';
import {
  categorizeFile,
  categorizeByFilename,
  extractExt,
  getMimeType,
  validateFiles,
} from '@/lib/fileTypes';
import {
  inferFileType,
  detectByMagicBytes,
  isProbablyUtf8,
} from '@/lib/fileTypeInference';

// ── extractExt ──

describe('extractExt', () => {
  it('extracts standard single-dot extensions', () => {
    expect(extractExt('main.ts')).toBe('.ts');
    expect(extractExt('photo.jpg')).toBe('.jpg');
    expect(extractExt('README.md')).toBe('.md');
    expect(extractExt('archive.tar.gz')).toBe('.gz');
  });

  it('is case-insensitive', () => {
    expect(extractExt('Photo.JPG')).toBe('.jpg');
    expect(extractExt('INDEX.HTML')).toBe('.html');
  });

  it('handles dot-prefixed hidden files as full extension', () => {
    expect(extractExt('.gitignore')).toBe('.gitignore');
    expect(extractExt('.editorconfig')).toBe('.editorconfig');
    expect(extractExt('.env')).toBe('.env');
    expect(extractExt('.prettierrc')).toBe('.prettierrc');
    expect(extractExt('.npmrc')).toBe('.npmrc');
  });

  it('handles compound extensions as single unit', () => {
    expect(extractExt('.env.example')).toBe('.env.example');
    expect(extractExt('.env.local')).toBe('.env.local');
    expect(extractExt('.env.development')).toBe('.env.development');
    expect(extractExt('.env.production')).toBe('.env.production');
  });

  it('returns empty string for files with no extension', () => {
    expect(extractExt('Dockerfile')).toBe('');
    expect(extractExt('Makefile')).toBe('');
    expect(extractExt('LICENSE')).toBe('');
  });
});

// ── categorizeFile ──

describe('categorizeFile', () => {
  it('categorizes image extensions', () => {
    expect(categorizeFile('.jpg')).toBe('image');
    expect(categorizeFile('.jpeg')).toBe('image');
    expect(categorizeFile('.png')).toBe('image');
    expect(categorizeFile('.gif')).toBe('image');
    expect(categorizeFile('.webp')).toBe('image');
  });

  it('categorizes PDF extension', () => {
    expect(categorizeFile('.pdf')).toBe('pdf');
  });

  it('categorizes Office extensions', () => {
    expect(categorizeFile('.doc')).toBe('office');
    expect(categorizeFile('.docx')).toBe('office');
    expect(categorizeFile('.xls')).toBe('office');
    expect(categorizeFile('.xlsx')).toBe('office');
    expect(categorizeFile('.ppt')).toBe('office');
    expect(categorizeFile('.pptx')).toBe('office');
  });

  it('categorizes text/code extensions', () => {
    expect(categorizeFile('.ts')).toBe('text');
    expect(categorizeFile('.tsx')).toBe('text');
    expect(categorizeFile('.js')).toBe('text');
    expect(categorizeFile('.py')).toBe('text');
    expect(categorizeFile('.json')).toBe('text');
    expect(categorizeFile('.md')).toBe('text');
    expect(categorizeFile('.yaml')).toBe('text');
    expect(categorizeFile('.sql')).toBe('text');
    // Production entry: categorizeFile. Issue #9479 could not reach the text
    // preview because .sol was missing from the shared allowlist; this minimal
    // extension pins the attachment/lightbox routing tier.
    expect(categorizeFile('.sol')).toBe('text');
    expect(categorizeFile('.sh')).toBe('text');
    expect(categorizeFile('.vue')).toBe('text');
    expect(categorizeFile('.svelte')).toBe('text');
    expect(categorizeFile('.txt')).toBe('text');
  });

  it('categorizes dot-prefixed hidden file extensions', () => {
    expect(categorizeFile('.gitignore')).toBe('text');
    expect(categorizeFile('.editorconfig')).toBe('text');
    expect(categorizeFile('.env')).toBe('text');
    expect(categorizeFile('.prettierrc')).toBe('text');
    expect(categorizeFile('.eslintrc')).toBe('text');
    expect(categorizeFile('.babelrc')).toBe('text');
    expect(categorizeFile('.npmrc')).toBe('text');
  });

  it('categorizes compound extensions', () => {
    expect(categorizeFile('.env.example')).toBe('text');
    expect(categorizeFile('.env.local')).toBe('text');
    expect(categorizeFile('.env.development')).toBe('text');
    expect(categorizeFile('.env.production')).toBe('text');
  });

  it('categorizes unknown safe extensions as generic files', () => {
    expect(categorizeFile('.zip')).toBe('file');
    expect(categorizeFile('.mp4')).toBe('file');
    expect(categorizeFile('.unknown')).toBe('file');
    expect(categorizeFile('')).toBeNull();
  });

  it('categorizes executable-like extensions as generic files (no client-side block)', () => {
    // 对标 Codex Desktop:不再做类型黑名单,可执行文件归为通用 file。
    expect(categorizeFile('.exe')).toBe('file');
    expect(categorizeFile('.app')).toBe('file');
    expect(categorizeFile('.msi')).toBe('file');
    expect(categorizeFile('.dll')).toBe('file');
    expect(categorizeFile('.EXE')).toBe('file');
  });

  it('is case-insensitive', () => {
    expect(categorizeFile('.PNG')).toBe('image');
    expect(categorizeFile('.PDF')).toBe('pdf');
    expect(categorizeFile('.TS')).toBe('text');
  });
});

// ── categorizeByFilename ──

describe('categorizeByFilename', () => {
  it('recognizes known filenames', () => {
    expect(categorizeByFilename('Dockerfile')).toBe('text');
    expect(categorizeByFilename('Makefile')).toBe('text');
    expect(categorizeByFilename('Gemfile')).toBe('text');
    expect(categorizeByFilename('Rakefile')).toBe('text');
    expect(categorizeByFilename('Procfile')).toBe('text');
    expect(categorizeByFilename('Vagrantfile')).toBe('text');
    expect(categorizeByFilename('Jenkinsfile')).toBe('text');
  });

  it('is case-insensitive', () => {
    expect(categorizeByFilename('DOCKERFILE')).toBe('text');
    expect(categorizeByFilename('makefile')).toBe('text');
  });

  it('returns null for unknown filenames', () => {
    expect(categorizeByFilename('README')).toBeNull();
    expect(categorizeByFilename('LICENSE')).toBeNull();
    expect(categorizeByFilename('foobar')).toBeNull();
  });
});

// ── getMimeType ──

describe('getMimeType', () => {
  it('returns correct MIME for image extensions', () => {
    expect(getMimeType('.jpg', 'image')).toBe('image/jpeg');
    expect(getMimeType('.jpeg', 'image')).toBe('image/jpeg');
    expect(getMimeType('.png', 'image')).toBe('image/png');
    expect(getMimeType('.gif', 'image')).toBe('image/gif');
    expect(getMimeType('.webp', 'image')).toBe('image/webp');
  });

  it('returns application/pdf for PDF category', () => {
    expect(getMimeType('.pdf', 'pdf')).toBe('application/pdf');
  });

  it('returns Office MIME types for office category', () => {
    expect(getMimeType('.docx', 'office')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(getMimeType('.xlsx', 'office')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(getMimeType('.pptx', 'office')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(getMimeType('.doc', 'office')).toBe('application/msword');
    expect(getMimeType('.xls', 'office')).toBe('application/vnd.ms-excel');
    expect(getMimeType('.ppt', 'office')).toBe('application/vnd.ms-powerpoint');
  });

  it('returns text/plain for text category', () => {
    expect(getMimeType('.ts', 'text')).toBe('text/plain');
    expect(getMimeType('.json', 'text')).toBe('text/plain');
    expect(getMimeType('.gitignore', 'text')).toBe('text/plain');
    expect(getMimeType('.env.example', 'text')).toBe('text/plain');
    expect(getMimeType('', 'text')).toBe('text/plain');
  });

  it('returns common media and archive MIME types for generic files', () => {
    expect(getMimeType('.mp4', 'file')).toBe('video/mp4');
    expect(getMimeType('.mov', 'file')).toBe('video/quicktime');
    expect(getMimeType('.mp3', 'file')).toBe('audio/mpeg');
    expect(getMimeType('.wav', 'file')).toBe('audio/wav');
    expect(getMimeType('.zip', 'file')).toBe('application/zip');
    expect(getMimeType('.unknown', 'file')).toBe('application/octet-stream');
  });

  it('returns octet-stream for unknown image extension', () => {
    expect(getMimeType('.bmp', 'image')).toBe('application/octet-stream');
  });
});

// ── validateFiles ──

describe('validateFiles', () => {
  // 对标 Codex Desktop:renderer 不再做大小 / 数量 / 类型前置校验,
  // validateFiles 退化为纯分类组装,errors 恒为空。

  const makeFile = (
    name: string,
    size = 1000,
    filePath = `/tmp/${name}`,
  ) => ({ name, path: filePath, size });

  it('validates normal supported files', () => {
    const files = [
      makeFile('photo.png'),
      makeFile('doc.pdf'),
      makeFile('main.ts'),
    ];
    const result = validateFiles(files, 0);
    expect(result.valid).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(result.valid[0].category).toBe('image');
    expect(result.valid[1].category).toBe('pdf');
    expect(result.valid[2].category).toBe('text');
  });

  it('accepts media and archives as generic path-only files', () => {
    const files = [makeFile('archive.zip'), makeFile('video.mp4'), makeFile('audio.mp3')];
    const result = validateFiles(files, 0);
    expect(result.valid).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(result.valid.map((file) => file.category)).toEqual(['file', 'file', 'file']);
    expect(result.valid.map((file) => file.mimeType)).toEqual([
      'application/zip',
      'video/mp4',
      'audio/mpeg',
    ]);
  });

  it('accepts executable-like files as generic attachments (no type block)', () => {
    const result = validateFiles([
      makeFile('app.exe'),
      makeFile('installer.dmg'),
      makeFile('plugin.dll'),
    ], 0);

    expect(result.valid).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(result.valid.map((file) => file.category)).toEqual(['file', 'file', 'file']);
  });

  it('accepts files far exceeding the former size limit', () => {
    const files = [makeFile('big.png', 5 * 1024 * 1024 * 1024)];
    const result = validateFiles(files, 0);
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts an unbounded number of attachments', () => {
    const files = Array.from({ length: 50 }, (_, i) => makeFile(`f${i}.ts`));
    const result = validateFiles(files, 999);
    expect(result.valid).toHaveLength(50);
    expect(result.errors).toHaveLength(0);
  });

  it('handles dot-prefixed hidden files', () => {
    const files = [makeFile('.gitignore'), makeFile('.env')];
    const result = validateFiles(files, 0);
    expect(result.valid).toHaveLength(2);
    expect(result.valid[0].category).toBe('text');
    expect(result.valid[0].ext).toBe('.gitignore');
    expect(result.valid[1].ext).toBe('.env');
  });

  it('handles compound extension files', () => {
    const files = [makeFile('.env.example')];
    const result = validateFiles(files, 0);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].ext).toBe('.env.example');
    expect(result.valid[0].category).toBe('text');
  });

  it('handles known extensionless filenames via fallback', () => {
    const files = [makeFile('Dockerfile'), makeFile('Makefile')];
    const result = validateFiles(files, 0);
    expect(result.valid).toHaveLength(2);
    expect(result.valid[0].ext).toBe('');
    expect(result.valid[0].category).toBe('text');
    expect(result.valid[1].category).toBe('text');
  });

  it('accepts unknown extensionless filenames as generic files', () => {
    const files = [makeFile('README'), makeFile('LICENSE')];
    const result = validateFiles(files, 0);
    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.valid[0]).toMatchObject({
      name: 'README',
      ext: '',
      category: 'file',
      mimeType: 'application/octet-stream',
    });
  });
});

// ── F-FI-8: detectByMagicBytes ──

/** Build a Uint8Array starting with `head` bytes, padded to total length head+tailLen. */
const makeBuf = (head: number[], tailLen = 0): Uint8Array => {
  const out = new Uint8Array(head.length + tailLen);
  out.set(head, 0);
  return out;
};

describe('detectByMagicBytes', () => {
  it('identifies PNG header → .png/image', () => {
    const buf = makeBuf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 16);
    expect(detectByMagicBytes(buf)).toEqual({
      ext: '.png',
      category: 'image',
      mimeType: 'image/png',
    });
  });

  it('identifies JPEG header → .jpg/image', () => {
    // FF D8 FF E0 ... (JFIF)
    const buf = makeBuf([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01], 4);
    expect(detectByMagicBytes(buf)).toEqual({
      ext: '.jpg',
      category: 'image',
      mimeType: 'image/jpeg',
    });
  });

  it('identifies GIF87a header → .gif/image', () => {
    const buf = makeBuf([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x10, 0x00, 0x10, 0x00, 0xf7, 0x00], 4);
    expect(detectByMagicBytes(buf)).toEqual({
      ext: '.gif',
      category: 'image',
      mimeType: 'image/gif',
    });
  });

  it('identifies GIF89a header → .gif/image', () => {
    const buf = makeBuf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x10, 0x00, 0xf7, 0x00], 4);
    expect(detectByMagicBytes(buf)).toEqual({
      ext: '.gif',
      category: 'image',
      mimeType: 'image/gif',
    });
  });

  it('identifies WebP RIFF/WEBP header (with arbitrary 4-byte size) → .webp/image', () => {
    // RIFF + arbitrary size + WEBP
    const buf = makeBuf(
      [0x52, 0x49, 0x46, 0x46, 0x12, 0x34, 0x56, 0x78, 0x57, 0x45, 0x42, 0x50],
      8,
    );
    expect(detectByMagicBytes(buf)).toEqual({
      ext: '.webp',
      category: 'image',
      mimeType: 'image/webp',
    });
  });

  it('identifies PDF header (%PDF-) → .pdf/pdf', () => {
    const buf = makeBuf([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3], 8);
    expect(detectByMagicBytes(buf)).toEqual({
      ext: '.pdf',
      category: 'pdf',
      mimeType: 'application/pdf',
    });
  });

  it('returns null for buffers shorter than the magic head window', () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e]);
    expect(detectByMagicBytes(buf)).toBeNull();
  });

  it('returns null for known-but-unsupported magic (e.g. ZIP local header)', () => {
    // PK\x03\x04 — present in ZIP / DOCX / XLSX
    const buf = makeBuf([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00], 16);
    expect(detectByMagicBytes(buf)).toBeNull();
  });
});

describe('isProbablyUtf8', () => {
  it('accepts pure ASCII', () => {
    const buf = new TextEncoder().encode('hello world\nconst x = 1;\n');
    expect(isProbablyUtf8(buf)).toBe(true);
  });

  it('accepts multi-byte UTF-8 (CJK)', () => {
    const buf = new TextEncoder().encode('塔纳托斯：不够，再来一次。\n');
    expect(isProbablyUtf8(buf)).toBe(true);
  });

  it('rejects buffers containing a NUL byte', () => {
    const buf = new Uint8Array([0x68, 0x65, 0x00, 0x6c, 0x6c, 0x6f]);
    expect(isProbablyUtf8(buf)).toBe(false);
  });

  it('rejects GBK byte sequences (invalid UTF-8)', () => {
    // GBK encoding of "你好" → 0xC4 0xE3 0xBA 0xC3 — invalid as UTF-8
    const buf = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
    expect(isProbablyUtf8(buf)).toBe(false);
  });

  it('rejects empty buffers (cannot positively classify nothing)', () => {
    expect(isProbablyUtf8(new Uint8Array(0))).toBe(false);
  });
});

describe('inferFileType', () => {
  it('infers ASCII text → .txt/text', () => {
    const buf = new TextEncoder().encode('console.log("hi");\n');
    expect(inferFileType(buf)).toEqual({
      ext: '.txt',
      category: 'text',
      mimeType: 'text/plain',
    });
  });

  it('returns null for binary blob with NUL but no known magic', () => {
    // 16 bytes of arbitrary binary including NULs, no recognized header
    const buf = new Uint8Array([
      0x01, 0x02, 0x00, 0x03, 0x04, 0x00, 0x05, 0x06,
      0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
    ]);
    expect(inferFileType(buf)).toBeNull();
  });

  it('returns null for GBK byte sequences', () => {
    // Pad to ≥ 12 bytes so detectByMagicBytes runs but matches nothing,
    // then the UTF-8 sniff also rejects.
    const buf = new Uint8Array([
      0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7,
      0xc4, 0xe3, 0xba, 0xc3,
    ]);
    expect(inferFileType(buf)).toBeNull();
  });

  it('returns null for empty buffers', () => {
    expect(inferFileType(new Uint8Array(0))).toBeNull();
  });

  it('infers short text shorter than the magic window → .txt/text', () => {
    // "hi\n" — only 3 bytes; magic check skipped, UTF-8 sniff succeeds.
    const buf = new TextEncoder().encode('hi\n');
    expect(inferFileType(buf)).toEqual({
      ext: '.txt',
      category: 'text',
      mimeType: 'text/plain',
    });
  });

  it('prefers magic bytes over UTF-8 sniff (PNG buffer with embedded NUL bytes)', () => {
    // Real PNG header → first 8 bytes magic, then IHDR chunk with NUL bytes.
    // UTF-8 sniff would reject this (NUL bytes); magic must win.
    const buf = makeBuf(
      [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d,                         // IHDR chunk length
      ],
      16,
    );
    const result = inferFileType(buf);
    expect(result).not.toBeNull();
    expect(result?.category).toBe('image');
    expect(result?.ext).toBe('.png');
  });
});

// ── F-FI-8: extension-first dispatch (useAttachments step-2 grouping) ──
//
// Behaviour-pinning tests for the "should we call peekFileHeader?" decision
// in useAttachments.addFiles. The hook splits incoming files into known /
// unknown using exactly this combination:
//
//     const ext = extractExt(name);
//     const category = ext ? categorizeFile(ext) : categorizeByFilename(name);
//     // category != null  → known   (no peek IPC)
//     // category == null  → unknown (peek + magic-byte/UTF-8 inference)
//
// 用户验收标准 #4 — `photo.txt` is in fact a PNG → 仍当 text 处理，不调 peek.
// We intentionally re-implement the predicate here as a one-liner so any
// change to the hook's grouping logic that breaks the extension-first
// guarantee fails this test, even without a full hook test rig (the project
// has no jsdom / @testing-library/react setup, and the I-2 brief explicitly
// forbids adding one).
function shouldPeekForUnknownType(name: string): boolean {
  const ext = extractExt(name);
  const category = ext ? categorizeFile(ext) : categorizeByFilename(name);
  return category === null;
}

describe('useAttachments step-2 grouping (extension-first dispatch)', () => {
  it('photo.txt is grouped as known text → does NOT trigger peek', () => {
    // Verdict #1: extension wins. Even if the file's actual bytes are PNG,
    // the .txt extension makes categorizeFile resolve to "text" and the
    // hook must skip peekFileHeader entirely.
    expect(extractExt('photo.txt')).toBe('.txt');
    expect(categorizeFile('.txt')).toBe('text');
    expect(shouldPeekForUnknownType('photo.txt')).toBe(false);
  });

  it('extensionless files DO trigger peek, but unknown extensions are generic files', () => {
    // Verdict #2: unknown extension → generic file, no peek. Extensionless
    // unknowns still peek so magic-byte/UTF-8 inference can upgrade them.
    // should hit the magic-byte/UTF-8 inference branch.
    expect(shouldPeekForUnknownType('screenshot')).toBe(true);   // no ext
    expect(shouldPeekForUnknownType('output')).toBe(true);       // no ext
    expect(shouldPeekForUnknownType('mystery.xyz')).toBe(false); // generic file
  });

  it('known extensionless filenames (Dockerfile/Makefile) skip peek', () => {
    // Verdict #3: categorizeByFilename rescues the no-ext case for the
    // hard-coded allowlist; these must NOT go through peek either.
    expect(shouldPeekForUnknownType('Dockerfile')).toBe(false);
    expect(shouldPeekForUnknownType('Makefile')).toBe(false);
  });
});
