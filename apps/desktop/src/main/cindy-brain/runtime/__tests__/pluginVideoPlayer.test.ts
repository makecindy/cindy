import { describe, expect, it } from 'vitest';
import {
  videoPlayerUrl,
  videoRequestAllowed,
  videoRequestDecision,
  isVideoPlayerDescendant,
  isOfficialVideoUrl,
  type VideoFrame,
} from '../pluginVideoPlayer.js';
// #8128: real request-admission API, unit tier. Existing partition tests cover wiring;
// these inputs distinguish URL confusion, ancestor forgery, redirects, and disposal.
// Minimal attack: a remote video frame requests its parent's /wake endpoint.
const prefix = 'cindy-ghost://video-test/';
const panel: VideoFrame = { url: prefix + 'panel.html', parent: null };
const wrapper: VideoFrame = { url: prefix + '__video_player__/bilibili?aid=1', parent: panel };
const player: VideoFrame = {
  url: 'https://player.bilibili.com/player.html?aid=1&page=1&autoplay=0',
  parent: wrapper,
};
describe('plugin video request policy', () => {
  it('never lets missing frame identity or revoked approval reach ordinary Host routes', () => {
    const request = { url: prefix + 'wake', resourceType: 'xhr' };
    expect(videoRequestDecision(request, prefix, true, true)).toBe(false);
    expect(videoRequestDecision({ ...request, frame: panel }, prefix, true, true)).toBeNull();
    const remote = { url: player.url, resourceType: 'subFrame', frame: player };
    expect(videoRequestDecision(remote, prefix, true, true)).toBe(true);
    expect(videoRequestDecision(remote, prefix, false, true)).toBe(false);
    expect(videoRequestDecision(remote, prefix, true, false)).toBe(false);
  });
  it('builds canonical official URLs and rejects ambiguous input', () => {
    expect(videoPlayerUrl(new URLSearchParams('aid=1&page=2'))).toBe(
      'https://player.bilibili.com/player.html?aid=1&page=2&autoplay=0',
    );
    for (const query of [
      'aid=1&aid=2',
      'aid=1&bvid=BV1xx411c7mD',
      'aid=1&autoplay=1',
      'aid=1&page=0',
      'bvid=https://evil.test',
      'aid=1&page=1000',
    ])
      expect(videoPlayerUrl(new URLSearchParams(query))).toBeNull();
  });
  it('only loads the matching player under the actual wrapper', () => {
    expect(
      videoRequestAllowed(
        { url: player.url, resourceType: 'subFrame', frame: { url: '', parent: wrapper } },
        prefix,
      ),
    ).toBe(true);
    for (const url of [
      player.url.replace('page=1', 'page=2'),
      player.url.replace('player.bilibili.com', 'player.bilibili.com.evil.test'),
      player.url.replace('https:', 'http:'),
      player.url.replace('https://', 'https://user@'),
      player.url.replace('.com/', '.com:444/'),
      prefix + 'wake',
      'about:blank',
    ]) {
      expect(videoRequestAllowed({ url, resourceType: 'subFrame', frame: player }, prefix)).toBe(
        false,
      );
    }
    expect(
      videoRequestAllowed(
        { url: player.url, resourceType: 'subFrame', frame: { url: '', parent: panel } },
        prefix,
      ),
    ).toBe(false);
    expect(isOfficialVideoUrl(player.url + '#redirect')).toBe(false);
  });
  it('bounds remote resources without inheriting Host routes or plugin networking', () => {
    for (const [url, resourceType] of [
      ['https://s1.hdslb.com/player.js', 'script'],
      ['https://api.bilibili.com/x/player/v2', 'xhr'],
      ['https://cdn.bilivideo.com/video.m4s', 'media'],
    ])
      expect(videoRequestAllowed({ url, resourceType, frame: player }, prefix)).toBe(true);
    for (const [url, resourceType] of [
      [prefix + 'wake', 'xhr'],
      ['http://127.0.0.1/', 'xhr'],
      ['https://evil.test/image', 'image'],
      ['https://api.bilibili.com/script', 'script'],
      ['wss://api.bilibili.com/', 'webSocket'],
      ['https://cdn.bilivideo.com/script', 'script'],
    ])
      expect(videoRequestAllowed({ url, resourceType, frame: player }, prefix)).toBe(false);
    expect(
      videoRequestAllowed(
        { url: 'https://api.bilibili.com/x/player/v2', resourceType: 'xhr', frame: panel },
        prefix,
      ),
    ).toBe(false);
    expect(videoRequestAllowed({ url: player.url, resourceType: 'subFrame' }, prefix)).toBe(false);
  });
  it('keeps about:blank descendants and disposed sources out of the ordinary plugin path', () => {
    const child = { url: 'about:blank', parent: player };
    expect(isVideoPlayerDescendant(child, prefix)).toBe(true);
    expect(
      videoRequestAllowed({ url: prefix + 'wake', resourceType: 'xhr', frame: child }, prefix),
    ).toBe(false);
    const disposed = {
      get url(): string {
        throw new Error('Render frame was disposed');
      },
      parent: null,
    };
    expect(isVideoPlayerDescendant(disposed, prefix)).toBe(true);
    expect(
      videoRequestAllowed({ url: player.url, resourceType: 'subFrame', frame: disposed }, prefix),
    ).toBe(false);
  });
});
