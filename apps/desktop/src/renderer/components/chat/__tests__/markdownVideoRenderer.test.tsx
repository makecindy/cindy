// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'media-test' } }) }));
afterEach(cleanup);

vi.mock('../ChatVideoView', () => ({
  ChatVideoView: ({
    src,
    filename,
  }: {
    src: string;
    filename: string;
    variant: string;
    sessionId?: string;
  }) => <video data-testid="markdown-video" data-src={src} aria-label={filename} />,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../ChatSessionFileContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ChatSessionFileContext')>()),
  useChatSessionFile: () => ({
    sessionId: 's1',
    workingDir: '/remote/proj',
    origin: { kind: 'device', deviceId: 'dev-1' },
  }),
}));

import { parseRemoteMediaUrl } from '../../../../shared/remoteMediaUrl';
import { MarkdownRenderer } from '../MarkdownRenderer';

// Production entry: cindy-ui audio must reach the audio-only handler, while
// video retains xdt-file's streaming/Range support. The previous Markdown-only
// cases never exercised rich media; a local .mp3 produced an unplayable URL.
// Minimal regression: an audio node with src="试听.mp3" (unit/DOM tier).
describe('MarkdownRenderer rich local media', () => {
  const richMedia = (kind: string, src: string) => '```cindy-ui\n' + JSON.stringify({
    version: 1, seq: 1, op: 'create', id: 'media', kind, props: { src },
  }) + '\n```';

  it.each([
    ['试听 100%20.mp3', 'C:/workspace/试听 100%20.mp3'],
    ['C:\\音乐\\主城 A.mp3', 'C:\\音乐\\主城 A.mp3'],
    ['file:///C:/music/a%2520.mp3', 'C:/music/a%20.mp3'],
    ['xdt-file://local/?path=C%3A%2Fmusic%2Fa.mp3', 'C:/music/a.mp3'],
  ])('routes local audio %s through xdt-audio', (src, expectedPath) => {
    const view = render(<MarkdownRenderer workingDir="C:/workspace" content={richMedia('audio', src)} renderRichAnswers />);
    const audio = view.container.querySelector('audio');
    expect(audio?.getAttribute('src')).toBe(`xdt-audio://local/?path=${encodeURIComponent(expectedPath)}`);
  });

  it.each(['xdt-audio://local/?path=%2Fmusic%2Fa.mp3', 'cindy-media://blobs/a.mp3', 'https://example.com/a.mp3'])('preserves playable audio URL %s', src => {
    const view = render(<MarkdownRenderer workingDir="/workspace" content={richMedia('audio', src)} renderRichAnswers />);
    expect(view.container.querySelector('audio')?.getAttribute('src')).toBe(src);
  });

  it('rewrites the corrected audio URL to its source device', () => {
    const view = render(<MarkdownRenderer workingDir="/remote/proj" currentSessionId="s1" content={richMedia('audio', '试听.mp3')} renderRichAnswers />);
    expect(parseRemoteMediaUrl(view.container.querySelector('audio')?.getAttribute('src') ?? '')).toEqual({
      origin: { kind: 'device', deviceId: 'dev-1' },
      origUrl: `xdt-audio://local/?path=${encodeURIComponent('/remote/proj/试听.mp3')}`,
    });
  });

  it('keeps local video on the streaming file protocol', () => {
    render(<MarkdownRenderer workingDir="/workspace" content={richMedia('video', 'clip.mp4')} renderRichAnswers />);
    expect(screen.getByTestId('markdown-video').getAttribute('data-src')).toBe('xdt-file://local/?path=%2Fworkspace%2Fclip.mp4');
  });

  it('does not expose privileged audio in untrusted previews', () => {
    const view = render(<MarkdownRenderer workingDir="/workspace" content={richMedia('audio', '/music/a.mp3')} renderRichAnswers allowPrivilegedLinks={false} />);
    expect(view.container.querySelector('audio')).toBeNull();
  });
});

describe('MarkdownRenderer managed video targets', () => {
  it.each([
    'cindy-media://blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4',
    'xdt-video://lizi-art-media-videos/generated.webm',
  ])('routes managed video %s in Markdown image syntax to the video preview', (src) => {

    render(
      <MarkdownRenderer
        workingDir="C:\workspace"
        content={'![Seedance 雪景版 KV 动态预览](' + src + ')'}
      />,
    );

    const video = screen.getByTestId('markdown-video');
    expect(video.getAttribute('data-src')).toBe(src);
    expect(video.getAttribute('aria-label')).toBe('Seedance 雪景版 KV 动态预览');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('rewrites the video source through the remote media origin in device-link sessions', () => {
    render(
      <MarkdownRenderer
        workingDir="/remote/proj"
        currentSessionId="s1"
        content="![clip](xdt-video://local/generated.mp4)"
      />,
    );

    const video = screen.getByTestId('markdown-video');
    const rewritten = parseRemoteMediaUrl(video.getAttribute('data-src') ?? '');
    // 远程会话里必须改写到 cindy-remote-media://，否则控制端拿自己的协议库取不到视频。
    expect(rewritten).not.toBeNull();
    expect(rewritten?.origUrl).toBe('xdt-video://local/generated.mp4');
    expect(rewritten?.origin).toEqual({ kind: 'device', deviceId: 'dev-1' });
  });
});
