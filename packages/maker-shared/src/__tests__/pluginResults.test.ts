import { describe, it, expect } from 'vitest';
import { extractPayloadToolResultMedia as media, extractPayloadToolResultFiles as files, extractPayloadToolCardIds as cards } from '../payloadSummary.js';
import { hasVisibleHistoryResult } from '../historyViewProjection.js';
const blob = (ext: string) => `cindy-media://blobs/${'a'.repeat(64)}.${ext}`;

describe('portable plugin results', () => {
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
});
