// @vitest-environment jsdom
import { act, createElement as el, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (payload: any) => void;

const h = vi.hoisted(() => ({
  players: [] as any[],
}));

function createPlayer() {
  const listeners = new Map<string, Set<Listener>>();
  const player = {
    status: 'idle',
    duration: 0,
    bufferedPosition: -1,
    pause: vi.fn(),
    addListener(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return { remove: () => listeners.get(event)?.delete(listener) };
    },
    emit(event: string, payload: any) {
      if (event === 'statusChange') player.status = payload.status;
      listeners.get(event)?.forEach((listener) => listener(payload));
    },
  };
  return player;
}

vi.mock('react-native', () => {
  const box = ({ children, testID }: any) => el('div', { 'data-testid': testID }, children);
  return {
    View: box,
    ActivityIndicator: () => null,
    StyleSheet: { create: (value: unknown) => value, absoluteFill: {}, hairlineWidth: 1 },
  };
});
vi.mock('expo', () => ({
  useEvent: (player: any, event: string, initial: any) => {
    const [value, setValue] = useState(initial);
    useEffect(() => {
      const sub = player.addListener(event, setValue);
      return () => sub.remove();
    }, [event, player]);
    return value;
  },
}));
vi.mock('expo-video', () => ({
  useVideoPlayer: () => {
    const [player] = useState(() => {
      const next = createPlayer();
      h.players.push(next);
      return next;
    });
    return player;
  },
  VideoView: () => el('video'),
}));
vi.mock('expo-glass-effect', () => ({ GlassView: ({ children }: any) => el('div', null, children) }));
vi.mock('@/session/useLiquidGlassAvailable', () => ({ useLiquidGlassAvailable: () => false }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children }: any) => el('span', { 'data-testid': 'hintText' }, children),
}));
vi.mock('@/debug/mobileDebugLog', () => ({ mobileDebugLog: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${options.percent}` : key),
  }),
}));

import { NativeVideoPlayer } from '@/session/NativeVideoPlayer';

let container: HTMLDivElement;
let root: Root;

function render(props: { visible: boolean; onError?: (detail: string) => void }) {
  act(() => {
    root.render(el(NativeVideoPlayer, {
      onError: props.onError ?? vi.fn(),
      testID: 'player',
      url: 'https://example.test/movie.mp4',
      visible: props.visible,
    }));
  });
  return h.players[h.players.length - 1];
}

const hint = () => container.querySelector('[data-testid="filePreview.videoBuffering"]');

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  h.players.length = 0;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('NativeVideoPlayer', () => {
  it('shows buffered percent only after a sustained loading state and hides it on resume', () => {
    const player = render({ visible: true });
    player.duration = 100;
    player.bufferedPosition = 42.7;
    act(() => player.emit('statusChange', { status: 'loading' }));
    act(() => vi.advanceTimersByTime(399));
    expect(hint()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(hint()?.textContent).toBe('files.preview.videoBufferingPercent:42');

    player.bufferedPosition = 80;
    act(() => vi.advanceTimersByTime(500));
    expect(hint()?.textContent).toBe('files.preview.videoBufferingPercent:80');

    act(() => player.emit('statusChange', { status: 'readyToPlay' }));
    expect(hint()).toBeNull();
    // Sampling stops with the hint; no timers left behind.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores brief loading blips and shows a plain hint before duration is known', () => {
    const player = render({ visible: true });
    act(() => player.emit('statusChange', { status: 'loading' }));
    act(() => vi.advanceTimersByTime(200));
    act(() => player.emit('statusChange', { status: 'readyToPlay' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(hint()).toBeNull();

    act(() => player.emit('statusChange', { status: 'loading' }));
    act(() => vi.advanceTimersByTime(400));
    expect(hint()?.textContent).toBe('files.preview.videoBuffering');
  });

  it('pauses once when the page becomes hidden and does not resume when shown again', () => {
    const player = render({ visible: true });
    render({ visible: false });
    render({ visible: false });
    expect(player.pause).toHaveBeenCalledTimes(1);
    render({ visible: true });
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  it('reports playback errors to the page', () => {
    const onError = vi.fn();
    const player = render({ visible: true, onError });
    act(() => player.emit('statusChange', { status: 'error', error: { message: 'Cannot Open' } }));
    expect(onError).toHaveBeenCalledWith('Cannot Open');
  });

  it('clears pending timers on unmount', () => {
    const player = render({ visible: true });
    act(() => player.emit('statusChange', { status: 'loading' }));
    act(() => vi.advanceTimersByTime(400));
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
