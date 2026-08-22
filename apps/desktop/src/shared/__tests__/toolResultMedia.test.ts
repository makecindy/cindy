import { describe, expect, it } from 'vitest';

import {
  extractToolResultMediaUrls,
  isToolImageUrl,
  isToolVideoUrl,
  toolResultMayHaveMedia,
} from '../toolResultMedia';
import { classifyBotArtifact, makeBotArtifact } from '../botArtifact';

/*
 * 这一组盯的是一个具体故障:**伙伴做出来的图在对话里好好地显示着,作品集里一张
 * 都没有。** 根因是「哪些字段装媒体」这份判定原来只活在 renderer 里,主进程侧的
 * 作品集投影够不着,于是只认文件写入和附件两条来源。
 */
describe('工具结果里的媒体', () => {
  it('图和视频各自从自己的字段里取出来,单数复数都收', () => {
    const media = extractToolResultMediaUrls({
      xdt_image_url: 'xdt-image://a.png',
      xdt_image_urls: ['cindy-media://blobs/b.png'],
      xdt_video_urls: ['cindy-media://blobs/c.mp4', 'xdt-video://d'],
    });
    expect(media).toEqual([
      { url: 'xdt-image://a.png', kind: 'image' },
      { url: 'cindy-media://blobs/b.png', kind: 'image' },
      { url: 'cindy-media://blobs/c.mp4', kind: 'video' },
      { url: 'xdt-video://d', kind: 'video' },
    ]);
  });

  it('媒体总仓地址的图/视频之分,只能靠它落在哪个字段', () => {
    // `cindy-media://<内容指纹>` 图和视频长得一模一样,两个判定都会放行 ——
    // 所以判定顺序不能决定归类,字段才能。
    const url = 'cindy-media://blobs/deadbeef';
    expect(isToolImageUrl(url)).toBe(true);
    expect(isToolVideoUrl(url)).toBe(true);
    expect(extractToolResultMediaUrls({ xdt_video_urls: [url] })).toEqual([
      { url, kind: 'video' },
    ]);
    // 靠地址猜必然猜不出来 —— 这正是 makeBotArtifact 要收 categoryHint 的原因。
    expect(classifyBotArtifact(url)).toBe('other');
  });

  it('categoryHint 让取件方把已知的类型带进作品,不留给分类器猜', () => {
    const item = makeBotArtifact({
      source: 'media',
      target: 'cindy-media://blobs/deadbeef',
      isRef: true,
      categoryHint: 'video',
      createdAt: 1,
    });
    expect(item.category).toBe('video');
    expect(item.path).toBeNull();
    expect(item.ref).toBe('cindy-media://blobs/deadbeef');
  });

  it('同一个地址出现在多个字段里只算一件', () => {
    const url = 'cindy-media://blobs/same';
    expect(extractToolResultMediaUrls({ xdt_image_urls: [url], xdt_video_urls: [url] })).toEqual([
      { url, kind: 'image' },
    ]);
  });

  it('声明了不当媒体渲染的结果,也不进作品集', () => {
    // 不上屏的东西不该出现在「TA 做出来的东西」里。
    expect(
      extractToolResultMediaUrls({
        _xdt_render_image: false,
        xdt_image_urls: ['xdt-image://hidden.png'],
      }),
    ).toEqual([]);
  });

  it('不认的取件协议一律丢掉,不把外链当作品', () => {
    expect(
      extractToolResultMediaUrls({
        xdt_image_urls: ['https://example.com/a.png', '/tmp/local.png', '', 42],
      }),
    ).toEqual([]);
  });

  it('快速否定:没有任何媒体字面量时不必解析整段结果', () => {
    expect(toolResultMayHaveMedia('{"ok":true,"path":"documents/a.docx"}')).toBe(false);
    expect(toolResultMayHaveMedia('{"xdt_image_urls":["xdt-image://a"]}')).toBe(true);
  });

  it('视频扩展名归 video,音频仍走 other(没有独立作品卡)', () => {
    expect(classifyBotArtifact('/w/a.mp4')).toBe('video');
    expect(classifyBotArtifact('/w/a.mov')).toBe('video');
    expect(classifyBotArtifact('xdt-video://x')).toBe('video');
    expect(classifyBotArtifact('xdt-audio://x')).toBe('other');
  });
});
