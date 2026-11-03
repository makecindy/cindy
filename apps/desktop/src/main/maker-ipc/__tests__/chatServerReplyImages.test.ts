import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const f = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn(), canRead: vi.fn(), resolve: vi.fn(), materialize: vi.fn(), db: {} }));
vi.mock('node:fs/promises', () => ({ default: { stat: f.stat, realpath: f.realpath } }));
vi.mock('../../cindy-media/taskImageDelivery.js', () => ({ materializeTaskImageTextResult: f.materialize }));
vi.mock('../../cindy-media/ledger.js', () => ({ sessionCanRead: f.canRead }));
vi.mock('../../cindy-media/blobStore.js', async original => ({ ...await original<typeof import('../../cindy-media/blobStore.js')>(), resolveSafe: f.resolve }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: f.db }) }));
import { materializeTaskImageMarkdown } from '../../cindy-media/taskImageMarkdown.js';
import { prepareChatReplyImages } from '../chatServerReplyImages.js';
const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
const other = `cindy-media://blobs/${'b'.repeat(64)}.png`;
const rich = (...ops: Record<string, unknown>[]) => '```cindy-ui\n' + ops.map((op, i) =>
  JSON.stringify({ version: 1, seq: i + 1, op: 'create', id: `n${i}`, ...op })).join('\n') + '\n```';
// Unit: public preparation entry; fake ledger/files isolate authorization and
// Markdown collection from settlement. Actual task importer has its own tests.
describe('generated reply image attachments', () => {
  beforeEach(() => {
    vi.resetAllMocks(); f.realpath.mockImplementation(async (source: string) => source); f.canRead.mockResolvedValue(true);
    f.resolve.mockReturnValue({ absPath: path.resolve('fixture', 'image.png'), mimeType: 'image/png' });
    f.stat.mockResolvedValue({ isFile: () => true, size: 3 });
    f.materialize.mockImplementation(async (_session, text) => ({ text, replacements: new Map(), failures: [] }));
  });
  it('imports local task images and deduplicates only rendered references', async () => {
    f.materialize.mockResolvedValue({ text: `![First](${url}) ![Again](${url})`, replacements: new Map([['xdt-image:///task/generated.png', url]]), failures: [] });
    const source = '![First](xdt-image:///task/generated.png) ![Again](xdt-image:///task/generated.png)';
    const result = await prepareChatReplyImages(source, 'lane', vi.fn());
    expect(f.materialize).toHaveBeenCalledExactlyOnceWith('lane', '![](<xdt-image:///task/generated.png>)\n![](<xdt-image:///task/generated.png>)');
    expect(result.text).toBe('First Again');
    expect(result.attachments).toEqual([expect.objectContaining({ url, path: null, category: 'image', size: 3 })]);
    expect(f.canRead).toHaveBeenCalledExactlyOnceWith('a'.repeat(64), 'lane', f.db);
  });
  it('retains original positions when importing images changes URL lengths', async () => {
    const local = 'xdt-image:///task/chart.png';
    const second = `cindy-media://blobs/${'b'.repeat(64)}.png`;
    const source = `report ![chart](${local}) data ![next](${second})`;
    f.materialize.mockResolvedValue({ text: source.replace(local, url), replacements: new Map([[local, url]]), failures: [] });
    const result = await prepareChatReplyImages(source, 'lane', vi.fn());
    expect(result.attachments.map(a => a.sourceOffset)).toEqual([source.indexOf('![chart]'), source.indexOf('![next]')]);
  });
  it('leaves text, code samples, external images and unreferenced definitions unchanged', async () => {
    const text = `Hello \`![sample](${url})\`\n![web](https://example.test/image.png)\n\n[unused]: ${url}`;
    expect(await prepareChatReplyImages(text, 'lane', vi.fn())).toEqual({ text, attachments: [] });
    expect(f.stat).not.toHaveBeenCalled(); expect(f.canRead).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'invalid', 'video', 'legacy', 'unimported'])('refuses an unavailable image: %s', async kind => {
    if (kind === 'foreign') f.canRead.mockResolvedValue(false);
    if (kind === 'video') f.resolve.mockReturnValue({ absPath: path.resolve('fixture', 'video.mp4'), mimeType: 'video/mp4' });
    const ref = kind === 'invalid' ? url + '?other=1' : kind === 'legacy' ? 'xdt-image://lane/image.png'
      : kind === 'unimported' ? 'xdt-image:///outside/image.png' : url;
    await expect(prepareChatReplyImages(`![image](${ref})`, 'lane', vi.fn())).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    expect(f.stat).not.toHaveBeenCalled();
  });
  it('rejects over 20 unique attachments without silently truncating', async () => {
    const images = Array.from({ length: 21 }, (_, i) => `![image](cindy-media://blobs/${i.toString(16).padStart(64, '0')}.png)`);
    expect((await prepareChatReplyImages(images.slice(0, 20).join(' '), 'lane', vi.fn())).attachments).toHaveLength(20);
    await expect(prepareChatReplyImages(images.join(' '), 'lane', vi.fn())).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });
  it.each(['//attacker/share/image.png', 'xdt-file:///%2Fattacker/share/image.png'])('rejects network image sources before metadata lookup: %s', async source => {
    const text = `![image](<${source}>)`;
    f.materialize.mockResolvedValue({ text, replacements: new Map(), failures: [source] });
    await expect(prepareChatReplyImages(text, 'lane', vi.fn())).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    expect(f.realpath).not.toHaveBeenCalled();
  });

  // #6892: the production prepare entry must treat final component images as deliveries,
  // while ignoring code examples and removed/obsolete nodes. Ledger and FS stay boundary fakes.
  it('delivers the same managed image from Markdown, components, or both without duplication', async () => {
    const component = rich({ kind: 'image', props: { src: url, alt: 'Diagram' } });
    for (const source of [`![Diagram](${url})`, component, `${component}\n![Diagram](${url})`]) {
      const result = await prepareChatReplyImages(source, 'lane', vi.fn());
      expect(result.attachments).toEqual([expect.objectContaining({ url, category: 'image' })]);
    }
  });
  it('walks the final tree in display order after patch, move and subtree removal', async () => {
    const source = rich(
      { kind: 'stack' },
      { parent: 'n0', kind: 'image', props: { src: url } },
      { id: 'removed', parent: 'n0', kind: 'image', props: { src: 'cindy-media://invalid' } },
      { op: 'remove', id: 'removed' },
      { op: 'patch', id: 'n1', props: { src: other } },
      { kind: 'image', props: { src: url } },
      { op: 'move', id: 'n5', parent: 'root', index: 0 },
    );
    const result = await prepareChatReplyImages(source, 'lane', vi.fn());
    expect(result.attachments.map(image => image.url)).toEqual([url, other]);
    expect(result.text).toBe(source);
    expect(f.canRead.mock.calls.map(call => call[0])).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });
  it('ignores code/text/src examples while collecting real image nodes', async () => {
    const source = rich(
      { kind: 'code', props: { text: `![example](${other})`, src: other } },
      { kind: 'text', props: { text: `![example](${other})`, src: other } },
      { kind: 'video', props: { src: other } },
      { kind: 'image', props: { src: url } },
    );
    expect((await prepareChatReplyImages(source, 'lane', vi.fn())).attachments.map(image => image.url)).toEqual([url]);
  });
  it('imports a component local path through the existing importer and deduplicates it with Markdown', async () => {
    const sourcePath = path.resolve('fixture', 'generated [image] & copy.png');
    const importImage = vi.fn().mockResolvedValue(url);
    f.materialize.mockImplementation(async (_session, text) => materializeTaskImageMarkdown(text, { importImage }));
    const component = rich({ kind: 'image', props: { src: sourcePath, alt: 'Diagram' } });
    const result = await prepareChatReplyImages(component + `\n![Again](${url})`, 'lane', vi.fn());
    expect(importImage).toHaveBeenCalledExactlyOnceWith(sourcePath);
    expect(result.attachments.map(image => image.url)).toEqual([url]);
    expect(result.text).toBe(component + '\nAgain');
  });
  // #7492 P1: file URLs were skipped with a successful empty delivery. Exercise
  // the public prepare entry and real Markdown importer; only byte/ledger boundaries are fakes.
  it.each(['encoded', 'literal spaces', 'localhost'])('imports a component file URL with %s through the existing checks', async form => {
    const sourcePath = path.resolve('fixture', '图片 [copy] #1 %.png');
    const fileUrl = pathToFileURL(sourcePath).href;
    const src = form === 'literal spaces' ? fileUrl.replace(/%20/g, ' ')
      : form === 'localhost' ? fileUrl.replace('file:///', 'file://localhost/') : fileUrl;
    const importImage = vi.fn().mockResolvedValue(url);
    f.materialize.mockImplementation(async (_session, text) => materializeTaskImageMarkdown(text, { importImage }));
    const result = await prepareChatReplyImages(rich({ kind: 'image', props: { src } }) + `\n![Again](${url})`, 'lane', vi.fn());
    expect(importImage).toHaveBeenCalledExactlyOnceWith(sourcePath);
    expect(result.attachments).toEqual([expect.objectContaining({ url, sourcePaths: [sourcePath], category: 'image' })]);
    expect(f.canRead).toHaveBeenCalledExactlyOnceWith('a'.repeat(64), 'lane', f.db);
  });
  it.each([
    'file://attacker/share/image.png', 'file:////attacker/share/image.png',
    'file:///image%2Fescape.png', 'file:///image%ZZ.png', 'file:///image%00.png',
    'file://user:pass@localhost/image.png', 'file:relative.png',
    'file:///image.png?remoteHostId=other', 'file:///image.png#fragment',
  ])('refuses an unsafe or malformed component file URL before any file access: %s', async src => {
    await expect(prepareChatReplyImages(rich({ kind: 'image', props: { src } }), 'lane', vi.fn()))
      .rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    expect(f.realpath).not.toHaveBeenCalled();
    expect(f.materialize).not.toHaveBeenCalled();
    expect(f.stat).not.toHaveBeenCalled();
  });
  it('rejects an imported component file URL when the existing task ledger denies the blob', async () => {
    const sourcePath = path.resolve('fixture', 'private image.png');
    f.materialize.mockImplementation(async (_session, text) => materializeTaskImageMarkdown(text, { importImage: async () => url }));
    f.canRead.mockResolvedValue(false);
    await expect(prepareChatReplyImages(rich({ kind: 'image', props: { src: pathToFileURL(sourcePath).href } }), 'lane', vi.fn()))
      .rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    expect(f.stat).not.toHaveBeenCalled();
  });
  it('keeps literal path characters from injecting extra image references during import', async () => {
    const sourcePath = path.resolve('fixture', 'literal &<>.png') + `\n![](${other})`;
    const importImage = vi.fn().mockResolvedValue(url);
    f.materialize.mockImplementation(async (_session, text) => materializeTaskImageMarkdown(text, { importImage }));
    const result = await prepareChatReplyImages(rich({ kind: 'image', props: { src: sourcePath } }), 'lane', vi.fn());
    expect(importImage).toHaveBeenCalledExactlyOnceWith(sourcePath);
    expect(result.attachments.map(image => image.url)).toEqual([url]);
  });
  it('never collects components inside code examples or a malformed document', async () => {
    const component = rich({ kind: 'image', props: { src: url } });
    for (const source of [`\`\`\`\`md\n${component}\n\`\`\`\``, component.replace('"seq":1', '"seq":2')]) {
      expect(await prepareChatReplyImages(source, 'lane', vi.fn())).toEqual({ text: source, attachments: [] });
    }
    expect(f.stat).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'missing', 'directory', 'empty', 'large', 'mime', 'invalid'])(
    'keeps component images behind existing validation: %s', async kind => {
      if (kind === 'foreign') f.canRead.mockResolvedValue(false);
      if (kind === 'missing') f.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      if (['directory', 'empty', 'large'].includes(kind)) f.stat.mockResolvedValue({
        isFile: () => kind !== 'directory', size: kind === 'empty' ? 0 : kind === 'large' ? 100 * 1024 * 1024 + 1 : 3,
      });
      if (kind === 'mime') f.resolve.mockReturnValue({ absPath: path.resolve('fixture', 'video.mp4'), mimeType: 'video/mp4' });
      await expect(prepareChatReplyImages(rich({ kind: 'image', props: { src: kind === 'invalid' ? url + '?invalid' : url } }), 'lane', vi.fn())).rejects.toThrow();
    },
  );
  it('shares the attachment limit across Markdown and component images', async () => {
    const markdown = Array.from({ length: 20 }, (_, i) => `![](cindy-media://blobs/${i.toString(16).padStart(64, '0')}.png)`).join('\n');
    await expect(prepareChatReplyImages(markdown + '\n' + rich({ kind: 'image', props: { src: url } }), 'lane', vi.fn())).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });
  it('stops after an execution changes during authorization', async () => {
    let current = true; f.canRead.mockImplementation(async () => { current = false; return true; });
    await expect(prepareChatReplyImages(`![image](${url})`, 'lane', () => { if (!current) throw new Error('STALE_EXECUTOR'); })).rejects.toThrow('STALE_EXECUTOR');
    expect(f.stat).not.toHaveBeenCalled();
  });
});
