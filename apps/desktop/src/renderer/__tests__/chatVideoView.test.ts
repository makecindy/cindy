// @vitest-environment jsdom
/** Tier 1: the message player now stays inline. Preserve keyboard access and
 * delegate native playback keys without reopening the superseded lightbox.
 * Native decoder/transport behavior is covered by the actual desktop acceptance;
 * this suite covers focus traversal and event ownership through the real view. */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@/hooks/useRemoteMediaUrl', () => ({ useRemoteMediaUrl: (url: string) => url }));

import { ChatVideoView } from '../components/chat/ChatVideoView';
import { __resetMediaBusForTests } from '@/lib/mediaPlaybackBus';

describe('ChatVideoView inline keyboard controls', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    __resetMediaBusForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['Enter', ' '])('keeps %s with the native player and lets Tab leave the message', async (key) => {
    const user = userEvent.setup();
    const view = render(React.createElement(React.Fragment, null,
      React.createElement('button', null, 'Before'),
      React.createElement(ChatVideoView, { src: 'xdt-video://control/clip.mp4', filename: 'clip.mp4', variant: 'tool-output' }),
      React.createElement('button', null, 'After'),
    ));
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    const video = view.container.querySelector('video')!;
    expect(document.activeElement).toBe(video);
    expect(video.controls).toBe(true);
    expect(video.getAttribute('src')).toBe('xdt-video://control/clip.mp4');

    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    fireEvent(video, event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(video);
    expect(view.container.querySelectorAll('video')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'chat.lightbox.close' })).toBeNull();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(video);
  });
});
