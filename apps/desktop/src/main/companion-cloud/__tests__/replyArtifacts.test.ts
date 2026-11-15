import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectReplyReferences, replyArtifactAttachments, replyPathToLookup, replyTextWithFiles, toolResultImageUrls, REPLY_ARTIFACTS_MAX } from '../replyArtifacts.js';

const HASH = 'a'.repeat(64);

describe('collectReplyReferences', () => {
  it('finds media addresses and the files a reply names, in prose, inline code and links', () => {
    const text = [
      `![chart](cindy-media://blobs/${HASH}.png)`,
      '做好了 documents/报告.docx，另见 `notes/todo.md`。',
      '[表格](documents/q3.xlsx) 和 [导出](xdt-file:///work/out/data.csv)',
      '放在了summary.pdf里，见documents/a.pdf。',
      '```\ndocuments/example-only.docx\n```',
      '网页 https://example.com/a/b.pdf 与 [站](https://x.dev/y.zip) 不算',
    ].join('\n');
    const found = collectReplyReferences(text);
    expect(found.blobs).toEqual([`cindy-media://blobs/${HASH}.png`]);
    expect(found.paths).toEqual(expect.arrayContaining(['documents/报告.docx', 'notes/todo.md', 'documents/q3.xlsx', '/work/out/data.csv', 'summary.pdf', 'documents/a.pdf']));
    expect(found.paths).not.toContain('documents/example-only.docx');
    expect(found.paths.some(item => item.includes('example.com') || item.includes('x.dev'))).toBe(false);
  });

  it('does not take a bare word with a dot, or a name without a deliverable extension, as a file', () => {
    expect(collectReplyReferences('版本是 v1.2，见 config.json 和 notes.txt').paths).toEqual([]);
  });

  it('takes Windows paths as paths: relative with backslashes, with a drive letter, in prose and in code', () => {
    const text = [
      '做好了 documents\\report.docx，另见 `out\\charts\\q3.png`。',
      '绝对路径 C:\\work\\documents\\summary.pdf 和 `D:\\data\\sheet.xlsx`',
      '不交付：config\\prod.yml、src\\keys\\id.json、tools\\run.bat',
    ].join('\n');
    expect(collectReplyReferences(text).paths).toEqual(['documents\\report.docx', 'out\\charts\\q3.png', 'C:\\work\\documents\\summary.pdf', 'D:\\data\\sheet.xlsx']);
  });

  it('names only deliverable formats, whatever form the path is written in', () => {
    const text = [
      '改了 config/production.yml 和 src/keys/service-account.json，还有 src/app.ts、deploy/.env、certs/server.pem、docs/notes.txt',
      '[配置](config/settings.toml) [密钥](xdt-file:///work/keys/id_rsa.key.json) ![图](assets/logo.png)',
      '交付：out/report.docx out/data.csv out/deck.pptx out/voice.mp3 out/demo.mp4 out/readme.md out/bundle.zip',
    ].join('\n');
    expect(collectReplyReferences(text).paths).toEqual(['assets/logo.png', 'out/report.docx', 'out/data.csv', 'out/deck.pptx', 'out/voice.mp3', 'out/demo.mp4', 'out/readme.md', 'out/bundle.zip']);
  });
});

describe('replyArtifactAttachments', () => {
  let root: string;
  let outside: string;
  const deps = (extra: Partial<Parameters<typeof replyArtifactAttachments>[3]> = {}) => ({
    roots: async () => [root], blob: async () => null, maxBytes: 1000, ...extra,
  });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reply-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'outside-')));
    await fs.mkdir(path.join(root, 'documents'));
    await fs.writeFile(path.join(root, 'documents', 'report.docx'), 'docx-bytes');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('lists the existing files inside the work folder that the reply names, by relative or absolute path', async () => {
    const files = await replyArtifactAttachments({ id: 'm1' }, `做好了 documents/report.docx，也见 ${path.join(root, 'documents', 'report.docx')} 和 documents/missing.docx`, 's1', deps());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'report.docx', category: 'file', path: path.join(root, 'documents', 'report.docx'), url: null, size: 10 });
  });

  it('sends a deliverable from the work folder but never code or configuration, even when the reply names it', async () => {
    await fs.mkdir(path.join(root, 'config'));
    await fs.mkdir(path.join(root, 'src', 'keys'), { recursive: true });
    await fs.writeFile(path.join(root, 'config', 'production.yml'), 'secret: 1');
    await fs.writeFile(path.join(root, 'src', 'keys', 'service-account.json'), '{}');
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {}');
    await fs.writeFile(path.join(root, 'documents', 'chart.png'), 'png');
    // A link to a configuration file by an allowed name does not make it a delivery either.
    await fs.symlink(path.join(root, 'config', 'production.yml'), path.join(root, 'documents', 'looks-fine.pdf'));
    const text = '见 config/production.yml、src/keys/service-account.json、src/index.ts、documents/report.docx、[图](documents/chart.png)、documents/looks-fine.pdf';
    const files = await replyArtifactAttachments({ id: 'm1' }, text, 's1', deps());
    expect(files.map(file => file.name).sort()).toEqual(['chart.png', 'report.docx']);
  });

  it('finds a file named with backslashes inside the work folder, and still refuses what is outside, hidden or not a delivery', async () => {
    await fs.writeFile(path.join(root, 'documents', 'chart.png'), 'png');
    await fs.writeFile(path.join(root, 'documents', 'prod.yml'), 'x: 1');
    await fs.writeFile(path.join(outside, 'secret.docx'), 'secret');
    await fs.mkdir(path.join(root, '.private'));
    await fs.writeFile(path.join(root, '.private', 'notes.docx'), 'hidden');
    const text = [
      '见 documents\\report.docx、`documents\\chart.png`、documents\\prod.yml、',
      `..\\${path.basename(outside)}\\secret.docx、.private\\notes.docx、`,
      '[表](documents\\report.docx)、C:\\no\\such\\drive\\a.docx',
    ].join('');
    const files = await replyArtifactAttachments({ id: 'm1' }, text, 's1', deps());
    expect(files.map(file => file.name).sort()).toEqual(['chart.png', 'report.docx']);
  });

  it('never reads outside the work folder, through a link out of it, a hidden file, or an oversized one', async () => {
    await fs.writeFile(path.join(outside, 'secret.docx'), 'secret');
    await fs.symlink(path.join(outside, 'secret.docx'), path.join(root, 'documents', 'link.docx'));
    await fs.writeFile(path.join(root, '.env.docx'), 'hidden');
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'config.txt'), 'hidden');
    await fs.writeFile(path.join(root, 'documents', 'big.docx'), 'x'.repeat(2000));
    const text = `${path.join(outside, 'secret.docx')} documents/link.docx .env.docx .git/config.txt documents/big.docx ../${path.basename(outside)}/secret.docx`;
    expect(await replyArtifactAttachments({ id: 'm1' }, text, 's1', deps())).toEqual([]);
    expect(await replyArtifactAttachments({ id: 'm1' }, 'documents/report.docx', 's1', deps({ roots: async () => [] }))).toEqual([]);
  });

  it('adds stored media the task may read as image or file, skips missing or oversized ones, and stops at the limit', async () => {
    const urls = Array.from({ length: REPLY_ARTIFACTS_MAX + 3 }, (_, index) => `cindy-media://blobs/${String(index).padStart(64, '0')}.png`);
    const blob = async (url: string) => (url === urls[0] ? null : url === urls[1] ? { mimeType: 'image/png', size: 5000 }
      : url === urls[2] ? { mimeType: 'video/mp4', size: 10 } : { mimeType: 'image/png', size: 10 });
    const files = await replyArtifactAttachments({ id: 'm1' }, urls.join(' '), 's1', deps({ blob }));
    expect(files).toHaveLength(REPLY_ARTIFACTS_MAX);
    expect(files[0]).toMatchObject({ url: urls[2], category: 'file', mimeType: 'video/mp4' });
    expect(files[1]).toMatchObject({ url: urls[3], category: 'image' });
    expect(new Set(files.map(file => file.id)).size).toBe(files.length);
  });
});

describe('images made by tools during the turn', () => {
  const url = (hash: string) => `cindy-media://blobs/${hash.repeat(64)}.png`;
  it('reads the stored images a tool result carries, whether it is stored as an object or as a JSON string', () => {
    const result = { ok: true, xdt_image_url: url('a'), xdt_image_urls: [url('b'), url('a'), 'xdt-image://old/x.png', 'https://example.com/x.png'] };
    expect(toolResultImageUrls(JSON.stringify(result))).toEqual([url('a'), url('b')]);
    expect(toolResultImageUrls(JSON.stringify(JSON.stringify(result)))).toEqual([url('a'), url('b')]);
    expect(toolResultImageUrls(JSON.stringify({ ...result, _xdt_render_image: false }))).toEqual([]);
    // The host's own ledger of produced media counts when the tool named no image field, also inside the ghost_call envelope.
    const ledger = { xdt_media_produced: [url('c'), `cindy-media://blobs/${'d'.repeat(64)}.mp4`, 'https://example.com/x.png'] };
    expect(toolResultImageUrls(JSON.stringify(ledger))).toEqual([url('c')]);
    expect(toolResultImageUrls(JSON.stringify({ ok: true, result: ledger }))).toEqual([url('c')]);
    expect(toolResultImageUrls(JSON.stringify({ ok: true, result: { ...ledger, _xdt_render_image: false } }))).toEqual([]);
    expect(toolResultImageUrls('not json')).toEqual([]);
    expect(toolResultImageUrls(null)).toEqual([]);
  });

  it('sends them with the reply although its text never names them, once and within the limit', async () => {
    const known = new Map([[url('a'), 5], [url('b'), 7]]);
    const asked: unknown[] = [];
    const files = await replyArtifactAttachments({ id: 'm1', createdAt: 100 }, `看看 ${url('b')}`, 's1', {
      roots: async () => [], maxBytes: 1000,
      blob: async address => (known.has(address) ? { mimeType: 'image/png', size: known.get(address)! } : null),
      turnImages: async (...args) => { asked.push(args); return [url('a'), url('b'), url('c')]; },
    });
    expect(asked).toEqual([['s1', { id: 'm1', createdAt: 100 }]]);
    expect(files.map(file => [file.url, file.category])).toEqual([[url('b'), 'image'], [url('a'), 'image']]);
    // A failure to look costs the reply nothing else.
    const plain = await replyArtifactAttachments({ id: 'm2', createdAt: 100 }, `看看 ${url('b')}`, 's1', {
      roots: async () => [], maxBytes: 1000, blob: async () => ({ mimeType: 'image/png', size: 1 }),
      turnImages: async () => { throw new Error('boom'); },
    });
    expect(plain.map(file => file.url)).toEqual([url('b')]);
  });

  it('names an image by the alt text the reply gave it, else image-<hash prefix>, never the 64-digit hash', async () => {
    const named = url('a'); const unnamed = url('b'); const tool = url('c'); const messy = url('d');
    const files = await replyArtifactAttachments({ id: 'm1', createdAt: 100 },
      `![绿色小青蛙](${named}) ![](${unnamed}) ![a/b:c*"d"](${messy}) ![ignored](https://x/y.png)\n\n\`\`\`\n![in code](${tool})\n\`\`\``, 's1', {
        roots: async () => [], maxBytes: 1000, blob: async () => ({ mimeType: 'image/png', size: 1 }),
        turnImages: async () => [tool],
      });
    expect(files.map(file => file.name)).toEqual(['绿色小青蛙.png', `image-${'b'.repeat(8)}.png`, 'a b c d.png', `image-${'c'.repeat(8)}.png`]);
  });
});

describe('replyTextWithFiles', () => {
  it('shows media the text already names as before, and links everything else below the reply', () => {
    const named = `cindy-media://blobs/${HASH}.png`;
    expect(replyTextWithFiles(`图 ![x](${named})`, [{ name: 'x.png', url: named, path: null }])).toBe(`图 ![x](${named})`);
    expect(replyTextWithFiles('看这个', [
      { name: 'chart.png', url: `cindy-media://blobs/${'b'.repeat(64)}.png`, path: null },
      { name: 'a (1).docx', path: '/att/a (1).docx', url: null },
      { name: 'gone.pdf', path: null, url: null },
    ])).toBe(`看这个\n\n![chart.png](cindy-media://blobs/${'b'.repeat(64)}.png)\n\n[a (1).docx](xdt-file://local/?path=%2Fatt%2Fa%20%281%29.docx)\n\n[附件: gone.pdf]`);
  });
});

describe('replyPathToLookup', () => {
  it('reads a relative name with either separator as folders inside the root, and leaves an absolute path alone', () => {
    expect(replyPathToLookup('documents\\report.docx', '/work', path.posix)).toBe('/work/documents/report.docx');
    expect(replyPathToLookup('documents/report.docx', '/work', path.posix)).toBe('/work/documents/report.docx');
    expect(replyPathToLookup('/work/documents/report.docx', '/other', path.posix)).toBe('/work/documents/report.docx');
    expect(replyPathToLookup('documents\\report.docx', 'C:\\work', path.win32)).toBe('C:\\work\\documents\\report.docx');
    expect(replyPathToLookup('documents/report.docx', 'C:\\work', path.win32)).toBe('C:\\work\\documents\\report.docx');
    expect(replyPathToLookup('C:\\work\\documents\\report.docx', 'C:\\other', path.win32)).toBe('C:\\work\\documents\\report.docx');
  });
});
