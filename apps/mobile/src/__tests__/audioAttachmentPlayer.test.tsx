// @vitest-environment jsdom
import { act, useImperativeHandle, type ReactNode, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioAttachmentPlayer } from '@/session/AudioAttachmentPlayer';
import { RemoteAttachmentPreview } from '@/session/RemoteAttachmentPreview';
import type { AudioPlaybackControls } from '@/session/mediaPlayerWebView';
import type { MobileMediaPlayerStatus } from '@/session/mediaPlayerWebViewHtml';

const runtime = vi.hoisted(() => ({
  mode: 'light' as 'light' | 'dark',
  os: 'ios',
  nodes: new Map<string, Record<string, any>>(),
  player: { play: vi.fn(), pause: vi.fn(), seek: vi.fn(), skip: vi.fn(), rate: vi.fn(), mute: vi.fn() },
  status: undefined as ((event: MobileMediaPlayerStatus) => void) | undefined,
  share: vi.fn(),
  shareCopy: vi.fn(),
}));

vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = () => runtime.mode === 'light' ? tokens.lightColors : tokens.darkColors;
  return {
    ...tokens,
    useTheme: () => ({ colors: colors() }),
    useThemedStyles: (makeStyles: (theme: ReturnType<typeof colors>) => unknown) => makeStyles(colors()),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('lucide-react-native', () => ({
  Airplay: () => null, AudioLines: () => null, Pause: () => null, Play: () => null,
  RotateCcw: () => null, RotateCw: () => null, Volume2: () => null, VolumeX: () => null,
}));
vi.mock('@/platform/chrome', () => ({
  NativePullDownMenu: ({ children, ...props }: { children: ReactNode; testID: string }) => {
    runtime.nodes.set(props.testID, props);
    return children;
  },
  usesNativePullDownMenu: () => false,
}));
vi.mock('@/platform/chrome/AnchoredPullDownMenu', async () => ({
  AnchoredPullDownMenu: (await import('@/platform/chrome')).NativePullDownMenu,
}));
vi.mock('react-native', () => {
  const view = (props: Record<string, any>) => {
    if (props.testID) runtime.nodes.set(props.testID, props);
    return <div>{props.children as ReactNode}</div>;
  };
  return { ActivityIndicator: () => null, Pressable: view, ScrollView: view, View: view, Modal: view,
    Platform: { get OS() { return runtime.os; } },
    Alert: { alert: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles } };
});
vi.mock('@/components/AppText', () => ({
  Text: (props: Record<string, any>) => {
    if (props.testID) runtime.nodes.set(props.testID, props);
    return <span>{props.children as ReactNode}</span>;
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));
vi.mock('expo-file-system', () => ({ File: class { exists = false; } }));
vi.mock('expo-sharing', () => ({ shareAsync: runtime.share }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ downloadRemoteMediaShareTemp: runtime.shareCopy }));
vi.mock('@/session/usePreviewChromeFrame', () => ({ usePreviewChromeFrame: () => ({ documentContentTop: 0 }) }));
vi.mock('@/session/PreviewChrome', () => ({
  PreviewFooter: () => null,
  PreviewHeader: (props: Record<string, unknown>) => { runtime.nodes.set('preview.header', props); return null; },
}));
vi.mock('@/session/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/session/BotGroupTextAttachmentPreview', () => ({
  BotGroupTextAttachmentPreview: () => null, botGroupTextAttachmentPreviewKind: () => null,
}));
vi.mock('@/session/PdfDocumentPreview', () => ({ PdfDocumentPreview: () => null }));
vi.mock('@/session/ModelDocumentPreview', () => ({ ModelDocumentPreview: () => null }));
vi.mock('@/session/NativeVideoPlayer', () => ({ NativeVideoPlayer: () => null }));
vi.mock('@/session/mediaPlayerWebView', () => ({
  RemoteMediaPlayerWebView: ({ audioControlsRef, onStatusChange }: {
    audioControlsRef: Ref<AudioPlaybackControls>;
    onStatusChange(event: MobileMediaPlayerStatus): void;
  }) => {
    useImperativeHandle(audioControlsRef, () => runtime.player);
    runtime.status = onStatusChange;
    return null;
  },
}));

const tone = { url: 'data:audio/wav;base64,AA==', mimeType: 'audio/wav' };
const touch = (locationX: number) => ({ nativeEvent: { locationX } });
const node = (name: string) => runtime.nodes.get(`message.${name}`)!;

describe('full-screen audio attachment controls', () => {
  let root: Root;
  let container: HTMLDivElement;
  const onStatusChange = vi.fn();
  const onRetry = vi.fn();
  const render = (options?: Partial<Parameters<typeof AudioAttachmentPlayer>[0]>, key = 0) => {
    act(() => root.render(<AudioAttachmentPlayer key={key} name="Short.wav" source={tone} readFailed={false}
      onStatusChange={onStatusChange} onRetry={onRetry} {...options} />));
  };
  const emit = (state: MobileMediaPlayerStatus['state'], detail?: Partial<MobileMediaPlayerStatus>) => {
    act(() => runtime.status?.({ type: 'xdt-media-player/status', state, ...detail }));
  };
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    runtime.mode = 'light';
    runtime.os = 'ios';
    runtime.nodes.clear();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it('waits for real readiness and follows play, buffering, pause and end events', () => {
    render({ source: null });
    expect(node('audioToggle').disabled).toBe(true);
    expect(node('audioDuration').children).toBe('––:––');
    render();
    expect(node('audioToggle').disabled).toBe(true);
    emit('ready', { currentTime: 0, duration: 62 });
    expect(node('audioDuration').children).toBe('01:02');
    node('audioToggle').onPress();
    expect(runtime.player.play).toHaveBeenCalledOnce();
    expect(node('audioToggle').accessibilityLabel).toBe('message.renderer.playAudio');
    emit('playing', { currentTime: 5, duration: 62 });
    expect(node('audioElapsed').children).toBe('00:05');
    emit('waiting', { paused: false, currentTime: 5, duration: 62 });
    expect(node('audioToggle').accessibilityLabel).toBe('message.attachmentPreview.pauseAudio');
    node('audioToggle').onPress();
    expect(runtime.player.pause).toHaveBeenCalledOnce();
    emit('paused', { currentTime: 5, duration: 62 });
    expect(node('audioToggle').accessibilityLabel).toBe('message.renderer.playAudio');
    emit('ended', { currentTime: 62, duration: 62 });
    expect(node('audioElapsed').children).toBe('01:02');
    node('audioToggle').onPress();
    expect(runtime.player.play).toHaveBeenCalledTimes(2);
  });

  it('can start playback when iOS has loaded metadata and is waiting for play', () => {
    render();
    emit('waiting', { paused: true, duration: 3.75, canSeek: true, canStart: true });
    expect(node('audioToggle').disabled).toBe(false);
    expect(node('audioToggle').accessibilityLabel).toBe('message.renderer.playAudio');
    node('audioToggle').onPress();
    expect(runtime.player.play).toHaveBeenCalledOnce();
    expect(node('audioToggle').accessibilityLabel).toBe('message.renderer.playAudio');
    emit('playing', { paused: false, currentTime: 1, duration: 3.75 });
    expect(node('audioElapsed').children).toBe('00:01');
  });

  it('previews a forward and backward drag and sends a single seek when released', () => {
    render();
    act(() => node('audioProgress').onLayout({ nativeEvent: { layout: { width: 212 } } }));
    emit('paused', { currentTime: 22, duration: 100, canSeek: false });
    expect(node('audioProgress').onStartShouldSetResponder()).toBe(false);
    emit('paused', { currentTime: 22, duration: 100, canSeek: true });
    expect(node('audioProgress').onStartShouldSetResponder()).toBe(true);
    act(() => node('audioProgress').onResponderGrant(touch(94)));
    act(() => node('audioProgress').onResponderMove(touch(156)));
    expect(node('audioElapsed').children).toBe('01:15');
    expect(runtime.player.seek).not.toHaveBeenCalled();
    act(() => node('audioProgress').onResponderRelease(touch(156)));
    expect(runtime.player.seek).toHaveBeenNthCalledWith(1, 75);
    emit('paused', { currentTime: 75, duration: 100, canSeek: true });
    act(() => node('audioProgress').onResponderGrant(touch(25)));
    act(() => node('audioProgress').onResponderRelease(touch(-10)));
    expect(runtime.player.seek).toHaveBeenNthCalledWith(2, 0);
    act(() => node('audioProgress').onResponderGrant(touch(25)));
    act(() => node('audioProgress').onResponderTerminate());
    expect(runtime.player.seek).toHaveBeenCalledTimes(2);
    node('audioProgress').onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
    expect(runtime.player.seek).toHaveBeenNthCalledWith(3, 85);
  });

  it('distinguishes file-read and playback failures, then returns to real readiness on retry', () => {
    render({ source: null, readFailed: true });
    expect(container.textContent).toContain('files.preview.readFailed');
    node('attachmentPreviewRetry').onPress();
    expect(onRetry).toHaveBeenCalledOnce();
    render({}, 1);
    emit('error');
    emit('waiting', { paused: true });
    expect(container.textContent).toContain('message.renderer.mediaError');
    expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }));
    node('attachmentPreviewRetry').onPress();
    expect(onRetry).toHaveBeenCalledTimes(2);
    render({}, 2);
    expect(node('audioToggle').disabled).toBe(true);
    emit('ready', { duration: 5, canSeek: true });
    expect(node('audioToggle').disabled).toBe(false);
  });

  it('keeps ±10, mute and rate tied to the same transport, and exposes the iOS route only when available', () => {
    render();
    expect(node('audioBackTen').disabled).toBe(true);
    expect(node('audioRoute').pointerEvents).toBe('none');
    emit('ready', { canSeek: true, duration: 60, muted: false, rate: 1, canRoute: true });
    expect(node('audioBackTen').disabled).toBe(false);
    node('audioBackTen').onPress();
    node('audioForwardTen').onPress();
    expect(runtime.player.skip.mock.calls).toEqual([[-10], [10]]);
    expect(node('audioRoute').pointerEvents).toBe('auto');
    node('audioMute').onPress();
    expect(runtime.player.mute).toHaveBeenCalledWith(true);
    node('audioSpeedMenu').onAction('1.5');
    expect(runtime.player.rate).toHaveBeenCalledWith(1.5);
    emit('ready', { canSeek: true, duration: 60, muted: true, rate: 1.5, canRoute: true });
    expect(node('audioSpeed').accessibilityValue.text).toBe('1.5×');
    expect(node('audioMute').accessibilityLabel).toBe('message.attachmentPreview.audioUnmute');
    node('audioMute').onPress();
    expect(runtime.player.mute).toHaveBeenLastCalledWith(false);
    runtime.os = 'android';
    render();
    expect(node('audioRoute').pointerEvents).toBe('none');
  });

  it('keeps a single bounded title with its full accessibility label in either theme', () => {
    render();
    const light = node('audioTitle').style.color;
    expect(container.textContent?.match(/Short\.wav/g)).toHaveLength(1);
    runtime.mode = 'dark';
    const name = '很长的音频附件标题 · 这一行可以自动换行 · 完整文件名仍然保留.wav';
    render({ name });
    expect(node('audioTitle')).toMatchObject({ numberOfLines: 3, accessibilityLabel: name });
    expect(node('audioTitle').style.color).not.toBe(light);
    expect(container.textContent).toContain(name);
  });

  it('uses the attachment resolver again on playback retry and preserves file export', async () => {
    const onClose = vi.fn();
    const resolve = vi.fn(async (_signal: AbortSignal, force?: boolean) => force ? tone : { ...tone, url: 'data:audio/wav;base64,YmFk' });
    const name = 'Remote.wav';
    runtime.shareCopy.mockResolvedValue('file:///fixture/Remote.wav');
    await act(async () => root.render(<RemoteAttachmentPreview name={name} resolve={resolve} onClose={onClose} />));
    expect(resolve).toHaveBeenNthCalledWith(1, expect.any(AbortSignal), false);
    const header = runtime.nodes.get('preview.header')!;
    expect(header).toMatchObject({ name, showTitle: false, onClose });
    expect(header.actions[0]).toMatchObject({ key: 'share', disabled: false });

    emit('error');
    expect(container.textContent).toContain('message.renderer.mediaError');
    await act(async () => node('attachmentPreviewRetry').onPress());
    expect(resolve).toHaveBeenNthCalledWith(2, expect.any(AbortSignal), true);
    emit('ready', { duration: 5, canSeek: true });
    expect(node('audioToggle').disabled).toBe(false);
    await act(async () => runtime.nodes.get('preview.header')!.actions[0].onPress());
    expect(runtime.shareCopy).toHaveBeenCalledWith(tone.url, tone.mimeType, name, expect.any(AbortSignal));
    expect(runtime.share).toHaveBeenCalledWith('file:///fixture/Remote.wav', { mimeType: tone.mimeType });
  });
});
