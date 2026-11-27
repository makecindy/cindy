// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AudioPlayerScrubber as IOSAudioPlayerScrubber } from '@/session/AudioPlayerScrubber.ios';
import { AudioPlayerScrubber as AndroidAudioPlayerScrubber } from '@/session/AudioPlayerScrubber.android';

const native = vi.hoisted(() => ({ screenReader: false, slider: {} as {
  onValueChange(value: number): void;
  onEditingChanged(editing: boolean): void;
  onValueChangeFinished(): void;
} }));

vi.mock('@expo/ui/swift-ui', () => ({
  Host: ({ children }: { children: ReactNode }) => children,
  Slider: (props: typeof native.slider) => { native.slider = props; return null; },
}));
vi.mock('@expo/ui/jetpack-compose', async () => await import('@expo/ui/swift-ui'));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: vi.fn(), accessibilityValue: vi.fn(), disabled: vi.fn(), frame: vi.fn(), tint: vi.fn(),
}));
vi.mock('@expo/ui/jetpack-compose/modifiers', () => ({ fillMaxWidth: vi.fn(), semantics: vi.fn(), testID: vi.fn() }));
vi.mock('@/theme', async () => ({ useTheme: () => ({ mode: 'light', colors: {} }) }));
vi.mock('@/hooks/useScreenReaderEnabled', () => ({ useScreenReaderEnabled: () => native.screenReader }));

it.each([
  { name: 'iOS', Scrubber: IOSAudioPlayerScrubber, start: () => native.slider.onEditingChanged(true), finish: () => native.slider.onEditingChanged(false) },
  { name: 'Android', Scrubber: AndroidAudioPlayerScrubber, start: () => {}, finish: () => native.slider.onValueChangeFinished() },
])('seeks once after a native $name drag, using its final value', ({ Scrubber, start, finish }) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.createElement('div'));
  const onPreview = vi.fn();
  const onSeek = vi.fn();
  try {
    act(() => root.render(<Scrubber enabled time={4} duration={10} label="Progress" valueText="04 / 10"
      onPreview={onPreview} onSeek={onSeek} />));
    act(() => {
      start();
      native.slider.onValueChange(8);
      native.slider.onValueChange(2);
    });
    expect(onPreview).toHaveBeenLastCalledWith(2);
    expect(onSeek).not.toHaveBeenCalled();
    act(finish);
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(2);
    expect(onPreview).toHaveBeenLastCalledWith(null);
  } finally {
    act(() => root.unmount());
  }
});

it('does not send playback-position echoes back to the transport on iOS', () => {
  const root = createRoot(document.createElement('div'));
  const onSeek = vi.fn();
  const render = () => <IOSAudioPlayerScrubber enabled time={4} duration={10} label="Progress" valueText="04 / 10"
    onPreview={vi.fn()} onSeek={onSeek} />;
  try {
    act(() => root.render(render()));
    act(() => native.slider.onValueChange(3));
    expect(onSeek).not.toHaveBeenCalled();
    native.screenReader = true;
    act(() => root.render(render()));
    act(() => native.slider.onValueChange(5));
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(5);
  } finally {
    native.screenReader = false;
    act(() => root.unmount());
  }
});
