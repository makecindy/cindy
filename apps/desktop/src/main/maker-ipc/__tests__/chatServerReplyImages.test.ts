import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
const f = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn(), canRead: vi.fn(), resolve: vi.fn(), materialize: vi.fn(), db: {} }));
vi.mock('node:fs/promises', () => ({ default: { stat: f.stat, realpath: f.realpath } }));
vi.mock('../../cindy-media/taskImageDelivery.js', () => ({ materializeTaskImageTextResult: f.materialize }));
vi.mock('../../cindy-media/ledger.js', () => ({ sessionCanRead: f.canRead }));
vi.mock('../../cindy-media/blobStore.js', async original => ({ ...await original<typeof import('../../cindy-media/blobStore.js')>(), resolveSafe: f.resolve }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: f.db }) }));
import { prepareChatReplyImages } from '../chatServerReplyImages.js';
import { mergeChatReplyAttachments } from '../chatServerReplyAttachments.js';
const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
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
    const source = '![First](xdt-image:///task/generated.png)';
    const result = await prepareChatReplyImages(source, 'lane', vi.fn());
    expect(f.materialize).toHaveBeenCalledExactlyOnceWith('lane', source);
    expect(result.text).toBe('First Again');
    expect(result.attachments).toEqual([expect.objectContaining({ url, path: null, category: 'image', size: 3 })]);
    expect(f.canRead).toHaveBeenCalledExactlyOnceWith('a'.repeat(64), 'lane', f.db);
  });
  // #6892: component images must reach the same authorized attachment path as Markdown.
  it('delivers final component images and keeps component descriptions', async () => {
    const block = '```cindy-ui\n' + [
      { version: 1, seq: 1, op: 'create', id: 'root', kind: 'stack' },
      { version: 1, seq: 2, op: 'create', id: 'image', parent: 'root', kind: 'image', props: { src: 'cindy-media://blobs/old.png', alt: 'Diagram' } },
      { version: 1, seq: 3, op: 'patch', id: 'image', props: { src: url } },
    ].map(node => JSON.stringify(node)).join('\n') + '\n```';
    const result = await prepareChatReplyImages(block, 'lane', vi.fn());
    expect(result.attachments).toEqual([expect.objectContaining({ url, category: 'image', path: null })]);
    expect(result.text).toBe(block);
    expect(f.canRead).toHaveBeenCalledExactlyOnceWith('a'.repeat(64), 'lane', f.db);
  });
  // Unit regression for review r4374366427 (#6892): preparation + merge must
  // preserve visible attachment order. Existing cases only cover each image
  // syntax separately; a component followed by Markdown/file is the minimum failure.
  it.each([false, true])('keeps mixed component, Markdown and file order (import=%s)', async imported => {
    const second = `cindy-media://blobs/${'b'.repeat(64)}.png`;
    const local = 'xdt-image:///task/chart.png';
    const block = '```cindy-ui\n' + JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'image', kind: 'image', props: { src: url } }) + '\n```';
    const markdown = `![chart](${imported ? local : second})`;
    const source = imported ? `${markdown}\n${block}\nreport` : `${block}\n${markdown}\nreport`;
    if (imported) f.materialize.mockResolvedValue({ text: source.replace(local, second), replacements: new Map([[local, second]]), failures: [] });
    const result = await prepareChatReplyImages(source, 'lane', vi.fn());
    const file = { id: 'report', name: 'report.pdf', category: 'file' as const, mimeType: 'application/pdf', size: 3,
      url: null, path: null, sourceOffset: source.indexOf('report') };
    expect(mergeChatReplyAttachments(result.attachments, [file]).map(a => a.id)).toEqual(imported
      ? [second, url, 'report'] : [url, second, 'report']);
    expect(result.attachments.find(a => a.url === url)?.sourceOffset).toBe(source.indexOf('```cindy-ui'));
  });
  it('does not collect component examples or non-image nodes', async () => {
    const node = JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'image', kind: 'image', props: { src: url } });
    const text = '````md\n```cindy-ui\n' + node + '\n```\n````\n' +
      '```cindy-ui\n' + node.replace('"kind":"image"', '"kind":"video"') + '\n```';
    expect(await prepareChatReplyImages(text, 'lane', vi.fn())).toEqual({ text, attachments: [] });
    expect(f.canRead).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'oversized'])('refuses %s component image delivery', async kind => {
    if (kind === 'foreign') f.canRead.mockResolvedValue(false);
    else f.stat.mockResolvedValue({ isFile: () => true, size: 100 * 1024 * 1024 + 1 });
    const text = '```cindy-ui\n' + JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'image', kind: 'image', props: { src: url } }) + '\n```';
    await expect(prepareChatReplyImages(text, 'lane', vi.fn())).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
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

  it('stops after an execution changes during authorization', async () => {
    let current = true; f.canRead.mockImplementation(async () => { current = false; return true; });
    await expect(prepareChatReplyImages(`![image](${url})`, 'lane', () => { if (!current) throw new Error('STALE_EXECUTOR'); })).rejects.toThrow('STALE_EXECUTOR');
    expect(f.stat).not.toHaveBeenCalled();
  });
});
