import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
const f = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn(), canRead: vi.fn(), resolve: vi.fn(), materialize: vi.fn(), db: {} }));
vi.mock('node:fs/promises', () => ({ default: { stat: f.stat, realpath: f.realpath } }));
vi.mock('../../cindy-media/taskImageDelivery.js', () => ({ materializeTaskImageTextResult: f.materialize }));
vi.mock('../../cindy-media/ledger.js', () => ({ sessionCanRead: f.canRead }));
vi.mock('../../cindy-media/blobStore.js', async original => ({ ...await original<typeof import('../../cindy-media/blobStore.js')>(), resolveSafe: f.resolve }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: f.db }) }));
import { prepareChatReplyImages } from '../chatServerReplyImages.js';
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
