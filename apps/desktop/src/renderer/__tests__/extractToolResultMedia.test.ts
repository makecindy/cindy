/**
 * extractToolResultMedia.test.ts
 * ---------------------------------------------------------------------------
 * Locks in the unified media extractor used by MessageStream / AgentActionRow.
 * If this changes shape, the chat bubble rendering of tool-output media
 * silently breaks (no test → no signal).
 */

import { describe, it, expect } from 'vitest';
import {
  extractAnchorCardId,
  extractToolResultMedia,
  extractToolResultImageUrls,
} from '@/components/chat/AgentActionRow';

describe('extractAnchorCardId', () => {
  it('提取顶层 xdt_anchor_card_id(非空 string 才认)', () => {
    expect(
      extractAnchorCardId(JSON.stringify({ ok: true, xdt_anchor_card_id: 'call-1' })),
    ).toBe('call-1');
    expect(extractAnchorCardId(JSON.stringify({ xdt_anchor_card_id: '' }))).toBeNull();
    expect(extractAnchorCardId(JSON.stringify({ xdt_anchor_card_id: 42 }))).toBeNull();
    expect(extractAnchorCardId(JSON.stringify({ ok: true }))).toBeNull();
    expect(extractAnchorCardId('')).toBeNull();
    expect(extractAnchorCardId('{ broken json xdt_anchor_card_id')).toBeNull();
  });
});

describe('extractToolResultMedia', () => {
  it('returns empty for empty / non-JSON input', () => {
    expect(extractToolResultMedia('')).toEqual([]);
    expect(extractToolResultMedia('plain text not json')).toEqual([]);
    expect(extractToolResultMedia('{ broken json')).toEqual([]);
  });

  it('extracts image-only result (xdt_image_urls)', () => {
    const r = JSON.stringify({
      ok: true,
      xdt_image_urls: [
        'xdt-image://lizi-art-media-images/a.png',
        'xdt-image://lizi-art-media-images/b.png',
      ],
    });
    expect(extractToolResultMedia(r)).toEqual([
      { kind: 'image', url: 'xdt-image://lizi-art-media-images/a.png' },
      { kind: 'image', url: 'xdt-image://lizi-art-media-images/b.png' },
    ]);
  });

  it('extracts singular xdt_image_url field', () => {
    const r = JSON.stringify({
      xdt_image_url: 'xdt-image://feishu-media-images/x.jpg',
    });
    expect(extractToolResultMedia(r)).toEqual([
      { kind: 'image', url: 'xdt-image://feishu-media-images/x.jpg' },
    ]);
  });

  it('extracts video-only result (xdt_video_urls)', () => {
    const r = JSON.stringify({
      ok: true,
      xdt_video_urls: ['xdt-video://lizi-art-media-videos/v.mp4'],
    });
    expect(extractToolResultMedia(r)).toEqual([
      { kind: 'video', url: 'xdt-video://lizi-art-media-videos/v.mp4' },
    ]);
  });

  it('extracts mixed image + video, preserves insertion order', () => {
    const r = JSON.stringify({
      xdt_image_url: 'xdt-image://x/a.png',
      xdt_image_urls: ['xdt-image://x/b.png'],
      xdt_video_urls: ['xdt-video://x/c.mp4'],
    });
    expect(extractToolResultMedia(r)).toEqual([
      { kind: 'image', url: 'xdt-image://x/a.png' },
      { kind: 'image', url: 'xdt-image://x/b.png' },
      { kind: 'video', url: 'xdt-video://x/c.mp4' },
    ]);
  });

  it('respects _xdt_render_image:false sentinel for both kinds', () => {
    const r = JSON.stringify({
      _xdt_render_image: false,
      xdt_image_urls: ['xdt-image://x/a.png'],
      xdt_video_urls: ['xdt-video://x/v.mp4'],
    });
    expect(extractToolResultMedia(r)).toEqual([]);
  });

  it('rejects URLs with the wrong scheme', () => {
    const r = JSON.stringify({
      xdt_image_url: 'http://evil.example/a.png',
      xdt_video_urls: ['file:///etc/passwd', 'xdt-image://wrong/scheme.mp4'],
    });
    expect(extractToolResultMedia(r)).toEqual([]);
  });

  it('de-duplicates by url across image + video fields', () => {
    const r = JSON.stringify({
      xdt_image_urls: [
        'xdt-image://x/a.png',
        'xdt-image://x/a.png',
        'xdt-image://x/b.png',
      ],
    });
    expect(extractToolResultMedia(r)).toEqual([
      { kind: 'image', url: 'xdt-image://x/a.png' },
      { kind: 'image', url: 'xdt-image://x/b.png' },
    ]);
  });

  it('extractToolResultImageUrls compat wrapper drops video and returns plain string[]', () => {
    const r = JSON.stringify({
      xdt_image_urls: ['xdt-image://x/a.png'],
      xdt_video_urls: ['xdt-video://x/v.mp4'],
    });
    expect(extractToolResultImageUrls(r)).toEqual(['xdt-image://x/a.png']);
  });


  it('ignores retired mivo-provider _xdt_model_files entries (MCP 退役,历史消息降级为普通图)', () => {
    const r = JSON.stringify({
      ok: true,
      xdt_image_urls: ['xdt-image://lizi-art-media-images/preview.png'],
      _xdt_model_files: [
        { provider: 'mivo', fileId: 'a'.repeat(24), format: 'GLB', targetFormat: 'GLB' },
      ],
    });
    const items = extractToolResultMedia(r);
    expect(items).toHaveLength(1);
    expect(items[0].modelFile).toBeUndefined();
  });

  it('rejects malformed _xdt_model_files entries (bad provider / fileId length)', () => {
    const r = JSON.stringify({
      xdt_image_urls: ['xdt-image://x/a.png'],
      _xdt_model_files: [
        { provider: 'wrong', fileId: 'a'.repeat(24) },
        { provider: 'mivo', fileId: 'short' },
        { provider: 'mivo' }, // missing fileId
      ],
    });
    // None matched → no modelFile pairing.
    expect(extractToolResultMedia(r)[0].modelFile).toBeUndefined();
  });

  it('does not attach modelFile when _xdt_model_files is absent (backward compat)', () => {
    const r = JSON.stringify({
      xdt_image_urls: ['xdt-image://x/a.png'],
    });
    expect(extractToolResultMedia(r)[0].modelFile).toBeUndefined();
  });

  it('attaches cindy-provider modelFile (意识 3D 链路:GLB 已在媒体总仓)', () => {
    // Mirrors xd-mivo ghost poll_3d_result output: preview via cindy-media
    // image + model paired via cindy-media GLB url. Renderer routes the
    // preview click to ModelLightbox (blob source) instead of ImageLightbox.
    const hash = 'f'.repeat(64);
    const r = JSON.stringify({
      ok: true,
      xdt_image_urls: [`cindy-media://blobs/${'e'.repeat(64)}.png`],
      _xdt_model_files: [
        { provider: 'cindy', url: `cindy-media://blobs/${hash}.glb`, format: 'GLB' },
      ],
    });
    const items = extractToolResultMedia(r);
    expect(items).toHaveLength(1);
    expect(items[0].modelFile).toEqual({
      provider: 'cindy',
      url: `cindy-media://blobs/${hash}.glb`,
      format: 'GLB',
    });
  });

  it('emits a standalone model item when a model file has no paired preview image', () => {
    const hash = '1'.repeat(64);
    const r = JSON.stringify({
      ok: true,
      _xdt_model_files: [{ provider: 'cindy', url: `cindy-media://blobs/${hash}.glb`, format: 'GLB' }],
    });
    expect(extractToolResultMedia(r)).toEqual([
      {
        kind: 'model',
        url: `cindy-media://blobs/${hash}.glb`,
        modelFile: { provider: 'cindy', url: `cindy-media://blobs/${hash}.glb`, format: 'GLB' },
      },
    ]);
  });

  it('only turns the unpaired remainder into model items (paired ones stay on their preview image)', () => {
    const [h1, h2] = ['2'.repeat(64), '3'.repeat(64)];
    const r = JSON.stringify({
      xdt_image_urls: [`cindy-media://blobs/${'e'.repeat(64)}.png`],
      _xdt_model_files: [
        { provider: 'cindy', url: `cindy-media://blobs/${h1}.glb`, format: 'GLB' },
        { provider: 'cindy', url: `cindy-media://blobs/${h2}.glb`, format: 'GLB' },
      ],
    });
    const items = extractToolResultMedia(r);
    expect(items.map((m) => m.kind)).toEqual(['image', 'model']);
    expect(items[0].modelFile?.url).toContain(h1);
    expect(items[1].url).toContain(h2);
  });

  it('ignores model files that are not managed .glb urls (no broken viewers)', () => {
    const r = JSON.stringify({
      _xdt_model_files: [
        { provider: 'cindy', url: `cindy-media://blobs/${'4'.repeat(64)}.gltf`, format: 'GLTF' },
        { provider: 'cindy', url: 'https://example.com/a.glb', format: 'GLB' },
        { provider: 'mivo', url: 'x', format: 'GLB' },
      ],
    });
    expect(extractToolResultMedia(r)).toEqual([]);
  });

  it('does not render model items when rendering is suppressed', () => {
    const r = JSON.stringify({
      _xdt_render_image: false,
      _xdt_model_files: [{ provider: 'cindy', url: `cindy-media://blobs/${'5'.repeat(64)}.glb`, format: 'GLB' }],
    });
    expect(extractToolResultMedia(r)).toEqual([]);
  });

  it('extracts ghost-world audio tracks (xdt_audio_tracks, cindy-media 协议)', () => {
    // Mirrors xd-mivo ghost poll_result output for Suno music: per-track
    // cindy-media audio url + cover/title/tags/lyrics/duration metadata,
    // hoisted to top-level by cindy-tools mcpServer.
    const audioUrl = `cindy-media://blobs/${'a'.repeat(64)}.mp3`;
    const coverUrl = `cindy-media://blobs/${'b'.repeat(64)}.jpg`;
    const r = JSON.stringify({
      ok: true,
      xdt_audio_tracks: [
        {
          kind: 'music',
          xdt_audio_url: audioUrl,
          cover_url: coverUrl,
          title: '雨后城市',
          tags: 'pop, upbeat',
          lyrics: '第一行\n第二行',
          duration_seconds: 176,
          suno_id: 'suno-1',
        },
        { kind: 'sound_effect', xdt_audio_url: `cindy-media://blobs/${'c'.repeat(64)}.mp3`, title: '开门声' },
      ],
    });
    const items = extractToolResultMedia(r);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      kind: 'audio',
      url: audioUrl,
      audioTrack: {
        kind: 'music',
        audioUrl,
        coverUrl,
        title: '雨后城市',
        tags: 'pop, upbeat',
        lyrics: '第一行\n第二行',
        durationSeconds: 176,
        sunoId: 'suno-1',
      },
    });
    expect(items[1].audioTrack?.kind).toBe('sound_effect');
  });

  it('legacy _xdt_audio_tracks (xdt-audio:// 协议) still extracts (退役 MCP 历史消息)', () => {
    const audioUrl = 'xdt-audio://local/?path=C%3A%5Ca.mp3';
    const r = JSON.stringify({
      _xdt_audio_tracks: [{ kind: 'music', xdt_audio_url: audioUrl, title: 'old' }],
    });
    const items = extractToolResultMedia(r);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('audio');
    expect(items[0].url).toBe(audioUrl);
  });

  it('xdt_audio_in_card 令牌只打标不裁决(压不压由 MessageStream 验证卡插槽后定)', () => {
    const audioUrl = `cindy-media://blobs/${'a'.repeat(64)}.mp3`;
    const r = JSON.stringify({
      xdt_audio_in_card: true,
      xdt_audio_tracks: [{ kind: 'music', xdt_audio_url: audioUrl }],
      xdt_image_urls: [`cindy-media://blobs/${'b'.repeat(64)}.png`],
    });
    const items = extractToolResultMedia(r);
    expect(items.map((i) => i.kind)).toEqual(['image', 'audio']);
    expect(items[1].audioInCard).toBe(true);
    // 无令牌时不打标(老消息/未入卡)。
    const plain = extractToolResultMedia(JSON.stringify({
      xdt_audio_tracks: [{ kind: 'music', xdt_audio_url: audioUrl }],
    }));
    expect(plain[0].audioInCard).toBeUndefined();
  });

  it('xdt_images_in_card 令牌只打标不裁决(与音频令牌同款「待验证声明」)', () => {
    const img = `cindy-media://blobs/${'c'.repeat(64)}.png`;
    const items = extractToolResultMedia(JSON.stringify({
      xdt_image_urls: [img],
      xdt_images_in_card: true,
    }));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('image');
    expect(items[0].imageInCard).toBe(true);
    // 无令牌 / 非布尔 true 时不打标。
    const plain = extractToolResultMedia(JSON.stringify({ xdt_image_urls: [img] }));
    expect(plain[0].imageInCard).toBeUndefined();
    const bogus = extractToolResultMedia(JSON.stringify({
      xdt_image_urls: [img],
      xdt_images_in_card: 'yes',
    }));
    expect(bogus[0].imageInCard).toBeUndefined();
  });

  it('rejects audio tracks with disallowed schemes; xdt_audio_urls fallback accepts both worlds', () => {
    const bad = JSON.stringify({
      xdt_audio_tracks: [{ kind: 'music', xdt_audio_url: 'https://evil.example/a.mp3' }],
    });
    expect(extractToolResultMedia(bad)).toEqual([]);
    const fallback = JSON.stringify({
      xdt_audio_urls: [
        `cindy-media://blobs/${'d'.repeat(64)}.mp3`,
        'xdt-audio://local/?path=x',
        'file:///etc/passwd.mp3',
      ],
    });
    const items = extractToolResultMedia(fallback);
    expect(items.map((i) => i.kind)).toEqual(['audio', 'audio']);
  });

  it('rejects cindy modelFile entries with wrong scheme / non-glTF extension', () => {
    const r = JSON.stringify({
      xdt_image_urls: ['cindy-media://blobs/' + 'e'.repeat(64) + '.png'],
      _xdt_model_files: [
        { provider: 'cindy', url: 'https://evil.example/x.glb' }, // wrong scheme
        { provider: 'cindy', url: 'cindy-media://blobs/' + 'f'.repeat(64) + '.fbx' }, // no in-app viewer
        // .gltf 不在媒体总仓扩展名白名单(协议取件必失败),同样拒绝。
        { provider: 'cindy', url: 'cindy-media://blobs/' + 'f'.repeat(64) + '.gltf' },
        { provider: 'cindy' }, // missing url
      ],
    });
    expect(extractToolResultMedia(r)[0].modelFile).toBeUndefined();
  });
});
