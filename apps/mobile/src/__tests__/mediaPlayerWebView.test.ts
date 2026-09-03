import { describe, expect, it } from 'vitest';
import {
  buildMediaPlayerWebViewCommand,
  buildMediaPlayerWebViewHtml,
  parseMediaPlayerWebViewMessage,
} from '@/session/mediaPlayerWebViewHtml';
import { createMediaPlayerWebViewLifecycle } from '@/session/mediaPlayerWebViewLifecycle';

describe('mediaPlayerWebView', () => {
  it('reloads only when backgrounding interrupted an unfinished load', () => {
    const lifecycle = createMediaPlayerWebViewLifecycle();

    lifecycle.onBackground();
    lifecycle.onLoadEnd();
    expect(lifecycle.consumeReloadOnActive()).toBe(true);
    expect(lifecycle.consumeReloadOnActive()).toBe(false);

    lifecycle.onLoadEnd();
    lifecycle.onBackground();
    expect(lifecycle.consumeReloadOnActive()).toBe(false);

    lifecycle.onLoadStart();
    lifecycle.onBackground();
    expect(lifecycle.consumeReloadOnActive()).toBe(true);
  });

  it('builds a video player document with controls and source metadata', () => {
    const html = buildMediaPlayerWebViewHtml({
      kind: 'video',
      mimeType: 'video/mp4',
      title: 'demo.mp4',
      url: 'https://oss.example/demo.mp4?signature=1',
    });

    expect(html).toContain('<video controls playsinline');
    expect(html).toContain('src="https://oss.example/demo.mp4?signature=1"');
    expect(html).toContain('type="video/mp4"');
    expect(html).toContain("type: 'xdt-media-player/status'");
    expect(html).toContain("parsed.type !== 'xdt-media-player/command'");
    expect(html).toContain("window.addEventListener('message', handleCommand)");
    expect(html).toContain("document.addEventListener('message', handleCommand)");
    expect(html).toContain("media.addEventListener('play'");
    expect(html).toContain("media.addEventListener('timeupdate'");
    expect(html).toContain('if (!media.paused) media.pause()');
    expect(html).not.toContain('<audio');
  });

  it('builds structured player commands for native lifecycle events', () => {
    expect(JSON.parse(buildMediaPlayerWebViewCommand('pause'))).toEqual({
      type: 'xdt-media-player/command',
      command: 'pause',
    });
    expect(JSON.parse(buildMediaPlayerWebViewCommand('reset'))).toEqual({
      type: 'xdt-media-player/command',
      command: 'reset',
    });
  });

  it('builds an audio player document and escapes dynamic values', () => {
    const html = buildMediaPlayerWebViewHtml({
      kind: 'audio',
      mimeType: 'audio/mpeg',
      title: '"bad" <script>',
      url: 'https://oss.example/a.mp3?x="><script>alert(1)</script>',
    });

    expect(html).toContain('<audio controls');
    expect(html).toContain('&quot;bad&quot; &lt;script&gt;');
    expect(html).toContain('https://oss.example/a.mp3?x=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('"><script>');
  });

  it('parses only structured player status messages from the WebView', () => {
    expect(parseMediaPlayerWebViewMessage(JSON.stringify({
      type: 'xdt-media-player/status',
      state: 'playing',
      currentTime: 12.6,
      duration: 120.2,
    }))).toEqual({
      type: 'xdt-media-player/status',
      state: 'playing',
      currentTime: 12.6,
      duration: 120.2,
      error: undefined,
    });

    expect(parseMediaPlayerWebViewMessage(JSON.stringify({
      type: 'xdt-media-player/status',
      state: 'error',
      currentTime: -1,
      duration: Number.POSITIVE_INFINITY,
      error: 'decode failed',
    }))).toEqual({
      type: 'xdt-media-player/status',
      state: 'error',
      currentTime: undefined,
      duration: undefined,
      error: 'decode failed',
    });

    expect(parseMediaPlayerWebViewMessage('not json')).toBeNull();
    expect(parseMediaPlayerWebViewMessage(JSON.stringify({ type: 'other', state: 'playing' }))).toBeNull();
    expect(parseMediaPlayerWebViewMessage(JSON.stringify({ type: 'xdt-media-player/status', state: 'seeking' }))).toBeNull();
  });
});
