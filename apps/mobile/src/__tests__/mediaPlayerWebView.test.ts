import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from 'vitest';
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

  it('pauses when its page becomes inactive and never auto-resumes on return', () => {
    const lifecycle = createMediaPlayerWebViewLifecycle();

    // 翻到本页 / 重复可见:无动作 —— 不代用户播放。
    expect(lifecycle.onVisibilityChange(true)).toBe(false);
    // 滑到相邻页 / 屏被压栈:暂停一次。
    expect(lifecycle.onVisibilityChange(false)).toBe(true);
    // 持续失活不重复发暂停。
    expect(lifecycle.onVisibilityChange(false)).toBe(false);
    // 回到本页不自动续播(播放权交还用户),下次失活再暂停。
    expect(lifecycle.onVisibilityChange(true)).toBe(false);
    expect(lifecycle.onVisibilityChange(false)).toBe(true);
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

  it('signals audio readiness, actual playback progress, and non-bubbling source failure', () => {
    const html = buildMediaPlayerWebViewHtml({ kind: 'audio', url: 'https://fixture.invalid/tone.wav' });
    const source = new EventTarget();
    const audio = Object.assign(new EventTarget(), {
      querySelector: () => source,
      paused: true,
      ended: false,
      duration: 2,
      currentTime: 0,
      error: null,
    });
    const events: ReturnType<typeof parseMediaPlayerWebViewMessage>[] = [];
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
      document: Object.assign(new EventTarget(), { querySelector: () => audio }),
      window: Object.assign(new EventTarget(), {
        ReactNativeWebView: { postMessage: (value: string) => events.push(parseMediaPlayerWebViewMessage(value)) },
      }),
    });
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(events).toEqual([]);
    audio.dispatchEvent(new Event('canplay'));
    expect(events.at(-1)).toMatchObject({ state: 'ready', duration: 2 });
    audio.paused = false;
    audio.dispatchEvent(new Event('play'));
    expect(events.at(-1)).toMatchObject({ state: 'ready' });
    audio.currentTime = 0.25;
    audio.dispatchEvent(new Event('playing'));
    expect(events.at(-1)).toMatchObject({ state: 'playing', currentTime: 0.25 });
    source.dispatchEvent(new Event('error'));
    expect(events.at(-1)).toMatchObject({ state: 'error' });
  });

  it('handles full-screen audio controls on iOS window and Android document message targets', async () => {
    const html = buildMediaPlayerWebViewHtml({ kind: 'audio', url: 'https://fixture.invalid/player.wav', externalAudioControls: true });
    expect(html).not.toContain('<audio controls');
    const events: ReturnType<typeof parseMediaPlayerWebViewMessage>[] = [];
    const audio = Object.assign(new EventTarget(), {
      querySelector: () => new EventTarget(),
      paused: true,
      ended: false,
      duration: 60,
      currentTime: 0,
      readyState: 0,
      HAVE_METADATA: 1,
      seekable: { length: 0, start: () => 0, end: () => 60 },
      play: vi.fn<() => Promise<void>>(),
      pause() { audio.paused = true; },
      error: null,
    });
    audio.play.mockImplementation(async () => {
      audio.paused = false;
      audio.dispatchEvent(new Event('play'));
    });
    const window = Object.assign(new EventTarget(), {
      ReactNativeWebView: { postMessage: (value: string) => events.push(parseMediaPlayerWebViewMessage(value)) },
    });
    const document = Object.assign(new EventTarget(), { querySelector: () => audio });
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], { window, document });
    const send = (target: EventTarget, command: Parameters<typeof buildMediaPlayerWebViewCommand>[0], seconds?: number) => {
      target.dispatchEvent(new MessageEvent('message', { data: buildMediaPlayerWebViewCommand(command, seconds) }));
    };
    audio.readyState = 1;
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(events.at(-1)).toMatchObject({ state: 'waiting', paused: true, canStart: true });
    audio.dispatchEvent(new Event('canplay'));
    expect(events.at(-1)).toMatchObject({ state: 'ready', paused: true, canSeek: false });
    send(window, 'seek', 40);
    expect(audio.currentTime).toBe(0);
    audio.seekable.length = 1;
    audio.dispatchEvent(new Event('progress'));
    expect(events.at(-1)).toMatchObject({ canSeek: true });

    send(window, 'play');
    expect(events.at(-1)).toMatchObject({ state: 'waiting', paused: false });
    audio.dispatchEvent(new Event('playing'));
    expect(events.at(-1)).toMatchObject({ state: 'playing', paused: false });
    send(document, 'seek', 40);
    audio.dispatchEvent(new Event('seeked'));
    expect(events.at(-1)).toMatchObject({ state: 'playing', currentTime: 40 });
    expect(events.at(-1)?.advanced).toBeUndefined();
    audio.currentTime = 40.25;
    audio.dispatchEvent(new Event('timeupdate'));
    expect(events.at(-1)).toMatchObject({ state: 'playing', currentTime: 40.25, advanced: true });
    audio.dispatchEvent(new Event('waiting'));
    audio.dispatchEvent(new Event('timeupdate'));
    expect(events.at(-1)).toMatchObject({ state: 'waiting', paused: false });
    send(document, 'pause');
    send(window, 'seek', 10);
    expect(events.at(-1)).toMatchObject({ state: 'paused', paused: true, currentTime: 10 });
    send(document, 'seek', 100);
    expect(audio.currentTime).toBe(60);
    send(document, 'seek', Number.NaN);
    expect(audio.currentTime).toBe(60);

    audio.play.mockRejectedValueOnce({ name: 'AbortError' });
    send(document, 'play');
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
    expect(events.at(-1)?.state).not.toBe('error');
    audio.play.mockRejectedValueOnce({ name: 'NotAllowedError' });
    send(window, 'play');
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ state: 'error', error: 'NotAllowedError' }));
  });

  it('changes mute, speed and relative seeks and opens the route picker from the same audio element', () => {
    const html = buildMediaPlayerWebViewHtml({
      kind: 'audio', url: 'https://fixture.invalid/tone.wav', externalAudioControls: true, audioRouteLabel: 'Output & AirPlay',
    });
    expect(html).toContain('aria-label="Output &amp; AirPlay"');
    const routeButton = Object.assign(new EventTarget(), { hidden: true });
    const audio = Object.assign(new EventTarget(), {
      querySelector: () => null, paused: true, ended: false, duration: 40, currentTime: 3,
      muted: false, playbackRate: 1, webkitCurrentPlaybackTargetIsWireless: false,
      webkitShowPlaybackTargetPicker: vi.fn(),
      seekable: { length: 1, start: () => 0, end: () => 40 },
    });
    const events: ReturnType<typeof parseMediaPlayerWebViewMessage>[] = [];
    const window = Object.assign(new EventTarget(), {
      ReactNativeWebView: { postMessage: (value: string) => events.push(parseMediaPlayerWebViewMessage(value)) },
    });
    const document = Object.assign(new EventTarget(), { querySelector: () => audio, getElementById: () => routeButton });
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], { window, document });
    const send = (command: Parameters<typeof buildMediaPlayerWebViewCommand>[0], value: number | boolean) =>
      document.dispatchEvent(new MessageEvent('message', { data: buildMediaPlayerWebViewCommand(command, value) }));
    audio.dispatchEvent(new Event('canplay'));
    expect(events.at(-1)).toMatchObject({ canRoute: true, wireless: false, muted: false, rate: 1 });
    expect(routeButton.hidden).toBe(false);
    routeButton.dispatchEvent(new Event('click'));
    expect(audio.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
    audio.webkitCurrentPlaybackTargetIsWireless = true;
    audio.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
    expect(events.at(-1)).toMatchObject({ wireless: true });

    send('skip', -10);
    expect(audio.currentTime).toBe(0);
    send('skip', 10);
    send('skip', 10);
    expect(audio.currentTime).toBe(20);
    audio.currentTime = 39;
    send('skip', 10);
    expect(audio.currentTime).toBe(40);
    send('mute', true);
    expect(events.at(-1)).toMatchObject({ muted: true });
    send('mute', false);
    expect(events.at(-1)).toMatchObject({ muted: false });
    send('rate', 1.5);
    expect(events.at(-1)).toMatchObject({ rate: 1.5 });
    send('rate', 99);
    expect(audio.playbackRate).toBe(1.5);
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
