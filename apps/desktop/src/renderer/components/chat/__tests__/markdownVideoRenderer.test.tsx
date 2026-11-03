// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

// 每个播放器实例一个编号：同一地址重新加载只能靠重建播放器（失败态绑在实例上）。
const videoMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../ChatVideoView', () => ({
  ChatVideoView: ({
    src,
    filename,
  }: {
    src: string;
    filename: string;
    variant: string;
    sessionId?: string;
  }) => {
    const [instance] = useState(() => ++videoMounts.count);
    return <video data-testid="markdown-video" data-src={src} data-instance={instance} aria-label={filename} />;
  },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const REMOTE_SESSION_FILE = {
  sessionId: 's1',
  workingDir: '/remote/proj',
  origin: { kind: 'device', deviceId: 'dev-1' },
  localConfirmed: false,
} as const;
const sessionFile = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../ChatSessionFileContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ChatSessionFileContext')>()),
  useChatSessionFile: () => sessionFile.current ?? REMOTE_SESSION_FILE,
}));

import { parseRemoteMediaUrl } from '../../../../shared/remoteMediaUrl';
import { _clearSmartResolveCache, toLocalFileUrl } from '@/lib/localPathResolver';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { _clearStreamingMediaKeys } from '../useWorkspaceMediaPath';

afterEach(() => {
  vi.restoreAllMocks();
  sessionFile.current = null;
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  _clearSmartResolveCache();
  _clearStreamingMediaKeys();
});

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

// Agent 进入任务目录的子文件夹工作后，常把媒体写成相对子文件夹的路径；直接拼到任务目录找不到，
// 嵌入的播放器和图片就是坏的（路径 chip 却能靠任务目录搜索点亮）。本机会话里媒体要复用同一套
// 解析：唯一命中换成真实文件，没有命中保持原拼接；远程会话不在本机搜索远端路径。
describe('MarkdownRenderer workspace-relative media in local sessions', () => {
  const richNode = (kind: 'video' | 'audio' | 'image', src: string) => '```cindy-ui\n' + JSON.stringify({
    version: 1, seq: 1, op: 'create', id: 'm', kind, props: { src, alt: 'clip' },
  }) + '\n```';
  const richVideo = richNode('video', 'renders/out/clip.mp4');
  const mediaSrc = (container: HTMLElement) => {
    const el = container.querySelector('[data-testid="markdown-video"], img, audio');
    return el?.getAttribute('data-src') ?? el?.getAttribute('src') ?? null;
  };

  // 会话文件上下文里与归属相关的两项；本机会话 = 会话视图已确认本机。
  type Ownership = { origin: object; localConfirmed: boolean };
  const LOCAL: Ownership = { origin: { kind: 'local' }, localConfirmed: true };

  function mount(
    content: string,
    ownership: Ownership,
    batch: Record<string, unknown> | Promise<Record<string, unknown>>,
  ) {
    sessionFile.current = { sessionId: 's1', workingDir: '/task', ...ownership };
    const resolvePathBatch = vi.fn(async () => batch);
    (window as unknown as { electronAPI: unknown }).electronAPI = { resolvePathBatch };
    const renderWith = (title?: string, isStreaming = false) => (
      <MarkdownRenderer workingDir="/task" currentSessionId="s1" currentSessionTitle={title} isStreaming={isStreaming} renderRichAnswers content={content} />
    );
    const view = render(renderWith());
    return { view, renderWith, resolvePathBatch };
  }
  const unique = (href: string) => ({ [href]: { status: 'unique', candidates: [`/task/film/${href}`], kind: 'file' } });

  it.each([
    ['cindy-ui video', richVideo, 'renders/out/clip.mp4', toLocalFileUrl],
    ['Markdown image', '![sheet](work/sheet.jpg)', 'work/sheet.jpg', toLocalFileUrl],
    // 本地音频要走 xdt-audio://，xdt-file:// 不放行音频。
    ['cindy-ui audio', richNode('audio', 'sfx/hit.wav'), 'sfx/hit.wav',
      (absPath: string) => toLocalFileUrl(absPath).replace(/^xdt-file:/, 'xdt-audio:')],
  ])('plays the unique workspace match for a %s whose joined path is missing', async (_label, content, href, toUrl) => {
    const { view } = mount(content, LOCAL, unique(href));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toUrl(`/task/film/${href}`)));
  });

  // `./`、重复分隔符、`..` 这些写法要先规范成主进程能按后缀匹配的形式再查；越出任务目录的不查。
  it.each(['./renders/out/clip.mp4', 'renders//out/./clip.mp4', 'film/../renders/out/clip.mp4'])(
    'looks up %s by its normalized path',
    async (href) => {
      const { view, resolvePathBatch } = mount(richNode('video', href), LOCAL, unique('renders/out/clip.mp4'));
      await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4')));
      expect(resolvePathBatch).toHaveBeenCalledWith({ hrefs: ['renders/out/clip.mp4'], workingDir: '/task' });
    },
  );

  // 直接拼接就能找到、但原写法不是规范写法（如在 POSIX 任务目录里写反斜杠）：原写法拼不出能用的
  // 地址，要换成找到的绝对路径；只有原写法本身就是规范写法时才保留原写法。
  it.each(['renders\\out\\clip.mp4'])(
    'loads the found file when %s matches the joined path in another spelling',
    async (href) => {
      const direct = { 'renders/out/clip.mp4': { status: 'unique', candidates: ['/task/renders/out/clip.mp4'], kind: 'file' } };
      const { view } = mount(richNode('video', href), LOCAL, direct);
      await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/renders/out/clip.mp4')));
    },
  );

  // 越出任务目录的路径、以及盘根 / 绝对路径（含 Windows 的 `\renders\...` 当前盘根写法）都不做后缀搜索，
  // 否则会把任务里恰好同后缀的无关文件换进来。
  it.each(['../clip.mp4', '\\renders\\out\\clip.mp4', '/renders/out/clip.mp4', 'C:\\renders\\out\\clip.mp4'])(
    'does not search for %s', async (href) => {
      const { resolvePathBatch } = mount(richNode('video', href), LOCAL, unique('renders/out/clip.mp4'));
      await act(async () => {});
      expect(resolvePathBatch).not.toHaveBeenCalled();
    },
  );

  // 解析结果晚到时，播放器不能先拿拼接出来的坏地址加载：那会先进入「视频不可用」。
  it('does not load the joined path before the workspace answer arrives', async () => {
    let answer!: (batch: Record<string, unknown>) => void;
    const { view } = mount(richVideo, LOCAL, new Promise((resolve) => { answer = resolve; }));
    await act(async () => {});
    expect(mediaSrc(view.container)).toBeNull();

    await act(async () => answer(unique('renders/out/clip.mp4')));
    expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4'));
  });

  // 共享解析缓存有容量上限；被其他引用挤掉后，已经找到的媒体不能退回拼接出来的坏地址。
  it('keeps a found file after the shared resolve cache drops it', async () => {
    const { view, renderWith, resolvePathBatch } = mount(richVideo, LOCAL, unique('renders/out/clip.mp4'));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4')));

    _clearSmartResolveCache();
    // 同一个播放器再次渲染(不重新挂载，所以不会重新解析)。
    view.rerender(renderWith('renamed task'));
    expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4'));
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);
  });

  // 共享缓存挤掉了它，组件自己记着唯一命中：窗口聚焦不能再查一次，否则一次偶发的未命中会把能用的
  // 地址换回拼接出来的坏地址（唯一命中不重查）。
  it('does not look up a found file again on focus after the shared cache drops it', async () => {
    const { view, resolvePathBatch } = mount(richVideo, LOCAL, unique('renders/out/clip.mp4'));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4')));

    _clearSmartResolveCache();
    later();
    resolvePathBatch.mockResolvedValue(missing);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await act(async () => {});
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);
    expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4'));
  });

  it('keeps the joined path when the workspace has no match', async () => {
    const { view } = mount(richVideo, LOCAL, { 'renders/out/clip.mp4': { status: 'none', candidates: [] } });
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/renders/out/clip.mp4')));
  });

  // 回复可能先引用产物、文件后写出：没有命中不是最终结论。新挂载、流式结束、窗口重新聚焦时
  // 重查一次，并要求主进程跳过它对否定结论的缓存；唯一命中不重查。
  const missing = { 'renders/out/clip.mp4': { status: 'none', candidates: [] } };
  const later = () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + 3_000);
  };
  it.each(['a later mount', 'the end of streaming', 'window focus'] as const)(
    'finds a file written after the first lookup on %s',
    async (boundary) => {
      const { view, renderWith, resolvePathBatch } = mount(richVideo, LOCAL, missing);
      if (boundary === 'the end of streaming') view.rerender(renderWith(undefined, true));
      await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/renders/out/clip.mp4')));

      later();
      resolvePathBatch.mockResolvedValue(unique('renders/out/clip.mp4'));
      if (boundary === 'a later mount') {
        view.unmount();
        const again = render(renderWith());
        await waitFor(() => expect(mediaSrc(again.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4')));
      } else {
        if (boundary === 'window focus') act(() => { window.dispatchEvent(new Event('focus')); });
        else view.rerender(renderWith(undefined, false));
        await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4')));
      }
      expect(resolvePathBatch).toHaveBeenLastCalledWith({ hrefs: ['renders/out/clip.mp4'], workingDir: '/task', revalidateNegative: true });
    },
  );

  // cindy-ui 图片在流式回答里按静态 Markdown 渲染，流式结束的时机要单独交给它。
  it('finds a file written after the first lookup for a cindy-ui image when streaming ends', async () => {
    const image = richNode('image', 'renders/out/still.png');
    const { view, renderWith, resolvePathBatch } = mount(image, LOCAL, { 'renders/out/still.png': { status: 'none', candidates: [] } });
    view.rerender(renderWith(undefined, true));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/renders/out/still.png')));

    later();
    resolvePathBatch.mockResolvedValue(unique('renders/out/still.png'));
    view.rerender(renderWith(undefined, false));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/still.png')));
  });

  // 回复先写普通 Markdown 图片、再开 cindy-ui 块：图片所在的前缀分片已经完整，但整条回复仍在输出，
  // 流式结束要以整条回复为准，否则后面块还在输出时文件才写出，图片会一直停在拼接地址。
  it('re-checks a Markdown image before a cindy-ui block when the whole reply finishes', async () => {
    const image = '![sheet](work/sheet.jpg)\n\n';
    const { view, resolvePathBatch } = mount(image, LOCAL, { 'work/sheet.jpg': { status: 'none', candidates: [] } });
    const reply = (content: string, isStreaming: boolean) => (
      <MarkdownRenderer workingDir="/task" currentSessionId="s1" isStreaming={isStreaming} renderRichAnswers content={content} />
    );
    view.rerender(reply(image + '```cindy-ui\n', true));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/work/sheet.jpg')));

    later();
    resolvePathBatch.mockResolvedValue(unique('work/sheet.jpg'));
    view.rerender(reply(image + richNode('video', 'https://example.com/clip.mp4'), false));
    await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe(toLocalFileUrl('/task/film/work/sheet.jpg')));
  });

  // 同一次重查里的多个媒体共用一次请求（主进程一次目录遍历），不按媒体个数各自遍历。
  it('re-checks several missing media of one task in a single request', async () => {
    const hrefs = ['renders/out/a.mp4', 'renders/out/b.mp4'];
    const content = '```cindy-ui\n' + hrefs.map((src, i) => JSON.stringify({
      ...(i === 0 ? { version: 1 } : {}), seq: i + 1, op: 'create', id: `m${i}`, kind: 'video', props: { src, alt: 'clip' },
    })).join('\n') + '\n```';
    const sources = (container: HTMLElement) =>
      [...container.querySelectorAll('[data-testid="markdown-video"]')].map((el) => el.getAttribute('data-src'));
    const { view, resolvePathBatch } = mount(content, LOCAL, Object.fromEntries(hrefs.map((h) => [h, { status: 'none', candidates: [] }])));
    await waitFor(() => expect(sources(view.container)).toEqual(hrefs.map((h) => toLocalFileUrl(`/task/${h}`))));
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);

    later();
    resolvePathBatch.mockResolvedValue({ ...unique(hrefs[0]), ...unique(hrefs[1]) });
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(sources(view.container)).toEqual(hrefs.map((h) => toLocalFileUrl(`/task/film/${h}`))));
    expect(resolvePathBatch).toHaveBeenCalledTimes(2);
    expect(resolvePathBatch).toHaveBeenLastCalledWith({ hrefs, workingDir: '/task', revalidateNegative: true });
  });

  // 时机到来时更早发出的查找还没回来：它可能在文件写出前就扫过了输出目录，回来仍未命中时
  // 要再查一次，不能让这次时机白白用掉。
  it.each(['window focus', 'the end of streaming'] as const)(
    'checks again after a lookup that was already running at %s',
    async (boundary) => {
      let answer!: (batch: Record<string, unknown>) => void;
      const { view, renderWith, resolvePathBatch } = mount(richVideo, LOCAL, new Promise((resolve) => { answer = resolve; }));
      if (boundary === 'the end of streaming') view.rerender(renderWith(undefined, true));
      await act(async () => {});
      expect(resolvePathBatch).toHaveBeenCalledTimes(1);

      later();
      if (boundary === 'window focus') act(() => { window.dispatchEvent(new Event('focus')); });
      else view.rerender(renderWith(undefined, false));
      resolvePathBatch.mockResolvedValue(unique('renders/out/clip.mp4'));
      await act(async () => answer(missing));

      await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4')));
      expect(resolvePathBatch).toHaveBeenCalledTimes(2);
      expect(resolvePathBatch).toHaveBeenLastCalledWith({ hrefs: ['renders/out/clip.mp4'], workingDir: '/task', revalidateNegative: true });
    },
  );

  // 查找发出与时机到来落在同一毫秒时分不出先后，按「时机之前发出」处理，回来未命中仍要补查。
  it('checks again when the lookup and window focus share the same millisecond', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let answer!: (batch: Record<string, unknown>) => void;
    const { view, resolvePathBatch } = mount(richVideo, LOCAL, new Promise((resolve) => { answer = resolve; }));
    await act(async () => {});
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);

    act(() => { window.dispatchEvent(new Event('focus')); });
    resolvePathBatch.mockResolvedValue(unique('renders/out/clip.mp4'));
    await act(async () => answer(missing));

    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4')));
    expect(resolvePathBatch).toHaveBeenLastCalledWith({ hrefs: ['renders/out/clip.mp4'], workingDir: '/task', revalidateNegative: true });
  });

  // 文件恰好写到直接拼接的位置：地址不变，但播放器之前已经加载失败，必须换一个新实例重新加载。
  it('reloads the player when a missing file appears at the joined path itself', async () => {
    const { view, resolvePathBatch } = mount(richVideo, LOCAL, missing);
    const player = () => view.container.querySelector('[data-testid="markdown-video"]');
    await waitFor(() => expect(player()?.getAttribute('data-src')).toBe(toLocalFileUrl('/task/renders/out/clip.mp4')));
    const before = player()?.getAttribute('data-instance');

    later();
    resolvePathBatch.mockResolvedValue({ 'renders/out/clip.mp4': { status: 'unique', candidates: ['/task/renders/out/clip.mp4'], kind: 'file' } });
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(player()?.getAttribute('data-instance')).not.toBe(before));
    expect(player()?.getAttribute('data-src')).toBe(toLocalFileUrl('/task/renders/out/clip.mp4'));
  });

  // 普通 Markdown 图片在流式结束时会随渲染方式切换重新挂载；新实例要接上「流式结束」这个时机，
  // 即使上一次没命中的结论还不到 2 秒。
  it('re-checks a Markdown image at the end of streaming across the remount that comes with it', async () => {
    const { view, renderWith, resolvePathBatch } = mount('![sheet](work/sheet.jpg)', LOCAL, { 'work/sheet.jpg': { status: 'none', candidates: [] } });
    view.rerender(renderWith(undefined, true));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/work/sheet.jpg')));

    resolvePathBatch.mockResolvedValue(unique('work/sheet.jpg'));
    view.rerender(renderWith(undefined, false));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/work/sheet.jpg')));
  });

  it('does not search again for a unique match', async () => {
    const { view, resolvePathBatch } = mount(richVideo, LOCAL, unique('renders/out/clip.mp4'));
    await waitFor(() => expect(mediaSrc(view.container)).toBe(toLocalFileUrl('/task/film/renders/out/clip.mp4')));
    later();
    act(() => { window.dispatchEvent(new Event('focus')); });
    await act(async () => {});
    expect(resolvePathBatch).toHaveBeenCalledTimes(1);
  });

  // 远程会话的设备归属可能晚于首次渲染才注入，那之前 origin 也是 local；归属没确认就不能拿
  // 远端任务目录在本机搜索。`%` 可能是字面文件名；主进程查找前会解码，可能换成另一个文件。
  it.each([
    ['a remote session', { origin: { kind: 'device', deviceId: 'dev-1' }, localConfirmed: false }, 'renders/out/clip.mp4'],
    ['a session whose device ownership is not resolved yet', { origin: { kind: 'local' }, localConfirmed: false }, 'renders/out/clip.mp4'],
    ['a path containing %', LOCAL, 'renders/out/clip%20final.mp4'],
  ])('does not search the local disk for %s', async (_label, ownership, href) => {
    const { view, resolvePathBatch } = mount(richNode('video', href), ownership, {});
    // 搜索请求按微任务批量发出；先让它有机会发出再断言。
    await act(async () => {});
    const src = mediaSrc(view.container) ?? '';
    expect(parseRemoteMediaUrl(src)?.origUrl ?? src).toBe(toLocalFileUrl(`/task/${href}`));
    expect(resolvePathBatch).not.toHaveBeenCalled();
  });
});
