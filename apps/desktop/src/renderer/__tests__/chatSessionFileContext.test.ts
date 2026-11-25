// @vitest-environment jsdom
/**
 * chatSessionFileContext.test.ts — 会话文件来源抽象 + Context 契约。
 * ---------------------------------------------------------------------------
 * 锁三件事:
 *  1. sessionFileOrigin 纯函数的判定优先级(deviceId > remoteHostId > local 单例)。
 *  2. ChatSessionFileContext 的 provider/consumer 语义:聊天流外 = local 默认值;
 *     deviceId 迟到注册(origin-injection race)时 context 更新必须穿透 React.memo
 *     触发消费者重渲——这是远程会话媒体不裂图的关键前提。
 *  3. gallery 改写同源契约:collectSessionImageSrcs 的输出必须与渲染侧
 *     rewriteToRemoteMedia(url, deviceId) 逐条一致,否则 ImageLightbox 的
 *     `sessionImages.includes(src)` 匹配失效(计数错 / 翻图退化)。
 *     回复正文图(Markdown / 组件图)同理:任务画廊按产品规则
 *     docs/product-rules/attachment-preview.md(2026-11-24 定稿)跨回合收录,
 *     从真实 MarkdownRenderer 点开必须落在画廊里的对应位置。最小失败输入:改动前
 *     回复图点开只有单张(无计数),代码块示例图若被计入则总数错。渲染时地址会变的
 *     回复图(URL 转码、引用式写法、任务目录内查找)另有一例,见该用例注释。
 *     Tier: unit/DOM(jsdom,真实 MarkdownRenderer + ImageLightbox)。
 */
import React, { memo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

// 可控的 remoteProjectsStore 假件:deviceMap 模拟 sessionId→deviceId 注册,
// notify() 模拟 store 更新广播(origin-injection race 的"迟到注册"时刻)。
const storeMock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const deviceMap = new Map<string, string>();
  return {
    listeners,
    deviceMap,
    notify: () => listeners.forEach((cb) => cb()),
  };
});

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    subscribe: (cb: () => void) => {
      storeMock.listeners.add(cb);
      return () => storeMock.listeners.delete(cb);
    },
  },
  getSessionDeviceId: (sessionId: string) => storeMock.deviceMap.get(sessionId),
}));
// Component answers key their view state by the signed-in user.
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'test-owner' } }) }));

import {
  LOCAL_FILE_ORIGIN,
  isRemoteFileOrigin,
  originDeviceId,
  resolveSessionFileOrigin,
  toRemoteMediaOrigin,
} from '@/lib/sessionFileOrigin';
import {
  ChatSessionFileProvider,
  useChatSessionFile,
  useChatSessionFileValue,
} from '../components/chat/ChatSessionFileContext';
import {
  collectSessionImageSrcs,
  collectTaskImageGallery,
  type RenderItem,
} from '../components/chat/MessageStream';
import { ImageGalleryContext, ImageGalleryScopeContext } from '../components/chat/ImageGalleryContext';
import { MarkdownRenderer } from '../components/chat/MarkdownRenderer';
import { _clearSmartResolveCache, toLocalFileUrl } from '@/lib/localPathResolver';
import i18n from '@/i18n';
import { rewriteToRemoteMediaOrigin, type RemoteMediaOrigin } from '../../shared/remoteMediaUrl';
import type { GhostCardSnapshot } from '@/cindy-brain/ghostCardStore';
import {
  createGhostCardSpawnIndex,
  ghostCardGalleryId,
} from '@/cindy-brain/ghostCardGallery';
import { GHOST_CARD_SPAWN_SEP } from '../../shared/ghost';

describe('sessionFileOrigin(纯函数)', () => {
  it('deviceId 优先于 remoteHostId,两者皆空回落 local 单例', () => {
    expect(resolveSessionFileOrigin('dev-1', 'host-1')).toEqual({ kind: 'device', deviceId: 'dev-1' });
    expect(resolveSessionFileOrigin(undefined, 'host-1')).toEqual({ kind: 'ssh', remoteHostId: 'host-1' });
    expect(resolveSessionFileOrigin(undefined, null)).toBe(LOCAL_FILE_ORIGIN);
    expect(resolveSessionFileOrigin(undefined, undefined)).toBe(LOCAL_FILE_ORIGIN);
    // 空串视为"无该维度"(与既有 `deviceId ? … : undefined` 判定口径一致)。
    expect(resolveSessionFileOrigin('', '')).toBe(LOCAL_FILE_ORIGIN);
  });

  it('isRemoteFileOrigin / originDeviceId 判别', () => {
    expect(isRemoteFileOrigin(LOCAL_FILE_ORIGIN)).toBe(false);
    expect(isRemoteFileOrigin({ kind: 'device', deviceId: 'd' })).toBe(true);
    expect(isRemoteFileOrigin({ kind: 'ssh', remoteHostId: 'h' })).toBe(true);
    expect(originDeviceId({ kind: 'device', deviceId: 'd' })).toBe('d');
    expect(originDeviceId({ kind: 'ssh', remoteHostId: 'h' })).toBeUndefined();
    expect(originDeviceId(LOCAL_FILE_ORIGIN)).toBeUndefined();
  });

  it('toRemoteMediaOrigin:device 带 deviceId,ssh 必须带 workdir,local → undefined', () => {
    expect(toRemoteMediaOrigin({ kind: 'device', deviceId: 'd' }, '/wd')).toEqual({
      kind: 'device',
      deviceId: 'd',
    });
    // device 不依赖 workdir(OSS 中转取任意绝对路径)。
    expect(toRemoteMediaOrigin({ kind: 'device', deviceId: 'd' }, '')).toEqual({
      kind: 'device',
      deviceId: 'd',
    });
    expect(toRemoteMediaOrigin({ kind: 'ssh', remoteHostId: 'h' }, '/remote/wd')).toEqual({
      kind: 'ssh',
      remoteHostId: 'h',
      workdir: '/remote/wd',
    });
    // ssh 无 workdir → 无法算 relPath,按不可改写处理。
    expect(toRemoteMediaOrigin({ kind: 'ssh', remoteHostId: 'h' }, '')).toBeUndefined();
    expect(toRemoteMediaOrigin(LOCAL_FILE_ORIGIN, '/wd')).toBeUndefined();
  });
});

/** 消费者探针:渲染当前 context 的 origin 摘要。 */
function OriginProbe() {
  const { origin, sessionId, workingDir } = useChatSessionFile();
  const label =
    origin.kind === 'device'
      ? `device:${origin.deviceId}`
      : origin.kind === 'ssh'
        ? `ssh:${origin.remoteHostId}`
        : 'local';
  return React.createElement('div', { 'data-testid': 'probe' }, `${label}|${sessionId ?? '-'}|${workingDir}`);
}

/** memo 包裹的中间层:验证 context 更新穿透 React.memo(props 恒等)。 */
const MemoBarrier = memo(function MemoBarrier() {
  return React.createElement(OriginProbe);
});

function Harness({
  sessionId,
  workingDir,
  remoteHostId,
}: {
  sessionId: string | undefined;
  workingDir: string;
  remoteHostId: string | null;
}) {
  const value = useChatSessionFileValue(sessionId, workingDir, remoteHostId);
  return React.createElement(ChatSessionFileProvider, { value, children: React.createElement(MemoBarrier) });
}

describe('ChatSessionFileContext', () => {
  it('provider 之外拿 local 默认值(聊天流外复用组件零行为变化)', () => {
    render(React.createElement(OriginProbe));
    expect(screen.getByTestId('probe').textContent).toBe('local|-|');
  });

  it('SSH 会话:remoteHostId 合成 ssh 来源', () => {
    render(React.createElement(Harness, { sessionId: 's1', workingDir: '/remote/wd', remoteHostId: 'host-9' }));
    expect(screen.getByTestId('probe').textContent).toBe('ssh:host-9|s1|/remote/wd');
  });

  it('deviceId 迟到注册时 context 更新穿透 memo(origin-injection race)', () => {
    render(React.createElement(Harness, { sessionId: 's2', workingDir: '/wd', remoteHostId: null }));
    expect(screen.getByTestId('probe').textContent).toBe('local|s2|/wd');

    act(() => {
      storeMock.deviceMap.set('s2', 'dev-42');
      storeMock.notify();
    });
    expect(screen.getByTestId('probe').textContent).toBe('device:dev-42|s2|/wd');
  });

  it('deviceId 优先于 remoteHostId(与 workdir-browse 判定一致)', () => {
    storeMock.deviceMap.set('s3', 'dev-7');
    render(React.createElement(Harness, { sessionId: 's3', workingDir: '/wd', remoteHostId: 'host-1' }));
    expect(screen.getByTestId('probe').textContent).toBe('device:dev-7|s3|/wd');
  });

  // 远程归属注入前 origin 暂时是 local;拿 workingDir 查本机文件系统的能力若只看 origin,
  // 会把远端路径交给本机搜索。localConfirmed 只认会话视图确认过的本机归属。
  it.each([
    ['已确认本机', 'c1', null, null, undefined, true],
    ['归属尚未解析', 'c2', undefined, null, undefined, false],
    ['会话视图判定为远端设备', 'c3', 'dev-1', null, undefined, false],
    ['SSH 会话', 'c4', null, 'host-1', undefined, false],
    ['已确认本机但 store 注册了设备', 'c5', null, null, 'dev-5', false],
  ])('localConfirmed:%s', (_label, sessionId, ownerDeviceId, remoteHostId, registered, expected) => {
    if (registered) storeMock.deviceMap.set(sessionId, registered);
    const { result } = renderHook(() => useChatSessionFileValue(sessionId, '/wd', remoteHostId, ownerDeviceId));
    expect(result.current.localConfirmed).toBe(expected);
  });
});

describe('collectSessionImageSrcs 与渲染改写同源契约', () => {
  const items: RenderItem[] = [
    {
      type: 'tool_media',
      key: 'm1',
      items: [
        { kind: 'image', url: 'xdt-image://sess/a.png' },
        { kind: 'video', url: 'xdt-video://sess/b.mp4' },
      ],
    },
    {
      type: 'message',
      key: 'u1',
      message: {
        clientId: 'u1',
        role: 'user',
        content: 'hi',
        images: [{ url: 'xdt-image://sess/up.png' }],
      } as never,
    },
  ];

  it('本地会话(来源空)原样输出', () => {
    expect(collectSessionImageSrcs(items, undefined).map((g) => g.src)).toEqual([
      'xdt-image://sess/a.png',
      'xdt-image://sess/up.png',
    ]);
  });

  it('device 远程会话输出与 rewriteToRemoteMediaOrigin 逐条一致(lightbox src 匹配前提)', () => {
    const origin: RemoteMediaOrigin = { kind: 'device', deviceId: 'dev-A' };
    const out = collectSessionImageSrcs(items, origin).map((g) => g.src);
    expect(out).toEqual([
      rewriteToRemoteMediaOrigin('xdt-image://sess/a.png', origin),
      rewriteToRemoteMediaOrigin('xdt-image://sess/up.png', origin),
    ]);
    // 改写确实发生(不是 no-op),防止两侧同时退化成原样输出而契约空转。
    expect(out[0]).toMatch(/^cindy-remote-media:\/\//);
  });

  it('ssh 远程会话:cache-id 型 xdt-image:// 不改写(远端取不到,保持本机语义)', () => {
    const origin: RemoteMediaOrigin = { kind: 'ssh', remoteHostId: 'h1', workdir: '/remote/wd' };
    const out = collectSessionImageSrcs(items, origin).map((g) => g.src);
    // 与渲染侧同一改写函数 → gallery src 匹配契约天然成立;此处锁 ssh 白名单语义。
    expect(out).toEqual([
      rewriteToRemoteMediaOrigin('xdt-image://sess/a.png', origin),
      rewriteToRemoteMediaOrigin('xdt-image://sess/up.png', origin),
    ]);
    expect(out[0]).toBe('xdt-image://sess/a.png');
  });

  it('持久化标注图:本地会话下发标注元数据,远程会话 strip(原图在被控端取不到)', () => {
    const annotatedItems: RenderItem[] = [
      {
        type: 'message',
        key: 'u2',
        message: {
          clientId: 'u2',
          role: 'user',
          content: 'hi',
          images: [
            {
              url: 'xdt-image://sess/burned.png',
              annotationSourceUrl: 'xdt-image://sess/orig.png',
              annotationStrokes: [{ points: [{ x: 0.1, y: 0.2 }] }],
            },
          ],
        } as never,
      },
    ];
    const local = collectSessionImageSrcs(annotatedItems, undefined);
    expect(local).toEqual([
      {
        src: 'xdt-image://sess/burned.png',
        annotationSourceUrl: 'xdt-image://sess/orig.png',
        annotationStrokes: [{ points: [{ x: 0.1, y: 0.2 }] }],
      },
    ]);
    const remote = collectSessionImageSrcs(annotatedItems, {
      kind: 'device',
      deviceId: 'dev-A',
    });
    expect(remote[0].annotationSourceUrl).toBeUndefined();
    expect(remote[0].annotationStrokes).toBeUndefined();
  });

  it('按消息流顺序合并用户图、插件生成图、衍生图和卡后回锚图', () => {
    const userImage = `cindy-media://blobs/${'1'.repeat(64)}.png`;
    const rootImage = `cindy-media://blobs/${'2'.repeat(64)}.png`;
    const spawnImage = `cindy-media://blobs/${'3'.repeat(64)}.png`;
    const anchoredImage = `cindy-media://blobs/${'4'.repeat(64)}.png`;
    const spawnCallId = `card-1${GHOST_CARD_SPAWN_SEP}001`;
    const ghostCards: GhostCardSnapshot = {
      version: 1,
      liveCards: [],
      byCallId: new Map([
        [
          'card-1',
          {
            status: 'ready',
            ghostId: 'cindy-art',
            html: `<img src="${rootImage}">`,
            height: 200,
          },
        ],
        [
          spawnCallId,
          {
            status: 'ready',
            ghostId: 'cindy-art',
            html: `<img src="${spawnImage}">`,
            height: 200,
          },
        ],
      ]),
    };
    const mixedItems: RenderItem[] = [
      {
        type: 'message',
        key: 'u-gallery',
        message: {
          clientId: 'u-gallery',
          role: 'user',
          content: 'compare',
          images: [{ url: userImage }],
        } as never,
      },
      {
        type: 'ghost_card',
        key: 'ghostcard-tool-1',
        callId: 'card-1',
        ghostId: 'cindy-art',
        tool: 'generate',
        toolCall: {
          clientId: 'tool-1',
          role: 'assistant',
          content: '',
        } as never,
        settled: true,
        media: [{ kind: 'image', url: anchoredImage }],
      },
    ];

    expect(createGhostCardSpawnIndex(ghostCards).get('card-1')).toHaveLength(1);
    expect(collectSessionImageSrcs(mixedItems, undefined, ghostCards)).toEqual([
      { src: userImage },
      { src: rootImage, galleryId: ghostCardGalleryId('card-1', 0) },
      { src: spawnImage, galleryId: ghostCardGalleryId(spawnCallId, 0) },
      { src: anchoredImage },
    ]);
  });

  it('回复正文图进入跨回合任务画廊，点开落在对应位置', () => {
    const blob = (char: string) => `cindy-media://blobs/${char.repeat(64)}.png`;
    const [uploaded, before, after, example, live] = ['1', '2', '3', '4', '5'].map(blob);
    const reply = [
      `Before:\n\n![before](${before})\n`,
      '```md',
      `![example](${example})`,
      '```',
      '',
      '```cindy-ui',
      `{"version":1,"seq":1,"op":"create","id":"after","kind":"image","props":{"src":"${after}","alt":"after"}}`,
      '```',
    ].join('\n');
    const turns: RenderItem[] = [
      {
        type: 'message',
        key: 'u1',
        message: {
          clientId: 'u1',
          role: 'user',
          content: 'Here is the bug',
          images: [{ url: uploaded, mimeType: 'image/png', originalName: 'bug.png' }],
        },
      },
      { type: 'message', key: 'a1', message: { clientId: 'a1', role: 'assistant', content: reply } },
      {
        type: 'message',
        key: 'a2',
        message: { clientId: 'a2', role: 'assistant', content: `![live](${live})`, isStreaming: true },
      },
    ];
    const gallery = collectTaskImageGallery(
      turns,
      new Map(turns.map((item) => [item.key, collectSessionImageSrcs([item])])),
      {
        cache: new Map(),
        workingDir: '/work',
        allowPrivilegedLinks: true,
        remoteMediaOrigin: undefined,
        ownershipPending: false,
        resolveInWorkspace: false,
      },
    );
    // 代码块里的示例图、仍在输出的回复不进画廊。
    expect(gallery.map((image) => image.src)).toEqual([uploaded, before, after]);

    render(
      React.createElement(
        ImageGalleryContext.Provider,
        { value: gallery },
        React.createElement(
          ImageGalleryScopeContext.Provider,
          { value: 'a1' },
          React.createElement(MarkdownRenderer, {
            renderRichAnswers: true,
            content: reply,
            workingDir: '/work',
            currentSessionId: 'task',
          }),
        ),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'before' }));
    expect(screen.getByText('2 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.media.prevImage') }));
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(screen.getByText('bug.png')).toBeTruthy();
  });

  // 渲染时地址会变的回复图：URL 被转码、引用式写法、相对任务目录写的路径（画廊在
  // 历史加载时、目录查找完成前就已建好）。最小失败输入：`![web](https://example.com/图片.png)`
  // 点开只有单张；`[r]:` 引用图不在画廊；翻到 `out/b.png` 显示直接拼接的坏地址。
  it('地址被改写或需在任务目录查找的回复图，点开与翻页都落在任务画廊', async () => {
    const resolvePathBatch = vi.fn(async ({ hrefs }: { hrefs: string[] }) =>
      Object.fromEntries(
        hrefs.map((href) => [href, { status: 'unique', candidates: [`/work/sub/${href}`], kind: 'file' }]),
      ),
    );
    (window as unknown as { electronAPI?: unknown }).electronAPI = { resolvePathBatch };
    try {
      const web = 'https://example.com/图片.png';
      const ref = 'https://example.com/ref.png';
      const first = `![web](${web})\n\n![ref][r]\n\n[r]: ${ref}`;
      const second = '![a](out/a.png)\n\n![b](out/b.png)';
      const turns: RenderItem[] = [
        { type: 'message', key: 'a1', message: { clientId: 'a1', role: 'assistant', content: first } },
        { type: 'message', key: 'a2', message: { clientId: 'a2', role: 'assistant', content: second } },
      ];
      const gallery = collectTaskImageGallery(turns, new Map(), {
        cache: new Map(),
        workingDir: '/work',
        allowPrivilegedLinks: true,
        remoteMediaOrigin: undefined,
        ownershipPending: false,
        resolveInWorkspace: true,
      });
      expect(gallery.map((image) => image.target)).toEqual([web, ref, 'out/a.png', 'out/b.png']);

      const session = { sessionId: 'task', workingDir: '/work', origin: LOCAL_FILE_ORIGIN, localConfirmed: true };
      const mount = (scope: string, content: string) =>
        render(
          React.createElement(ChatSessionFileProvider, {
            value: session,
            children: React.createElement(
              ImageGalleryContext.Provider,
              { value: gallery },
              React.createElement(
                ImageGalleryScopeContext.Provider,
                { value: scope },
                React.createElement(MarkdownRenderer, {
                  renderRichAnswers: true,
                  content,
                  workingDir: '/work',
                  currentSessionId: 'task',
                }),
              ),
            ),
          }),
        );
      const next = () => fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.media.nextImage') }));

      const firstView = mount('a1', first);
      fireEvent.click(screen.getByRole('button', { name: 'web' }));
      expect(screen.getByText('1 / 4')).toBeTruthy();
      next();
      expect(screen.getByText('2 / 4')).toBeTruthy();
      firstView.unmount();

      mount('a2', second);
      fireEvent.click(await screen.findByRole('button', { name: 'a' }));
      expect(screen.getByText('3 / 4')).toBeTruthy();
      next();
      expect(screen.getByText('4 / 4')).toBeTruthy();
      // The viewer resolves the entry in the task folder, as the reply does.
      await waitFor(() =>
        expect(document.querySelector('.modal-panel img')?.getAttribute('src')).toBe(
          toLocalFileUrl('/work/sub/out/b.png'),
        ),
      );
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
      _clearSmartResolveCache();
    }
  });

  // PR #12724 review：同一回复里重复出现的图要从点开的那一处开始；查看器里一张还没写出
  // 的相对路径图，文件写到原位置后要重新加载，不能停在失败态。最小失败输入：回复依次
  // 是 A、B、A，点最后的 A 显示「1 / 3」；两个相同的组件图块点第二个显示「1 / 2」；
  // `out/c.png` 加载失败后文件出现，失败提示不消失。
  it('重复图从点开处开始，查看器里后写出的文件会重新加载', async () => {
    const blob = (char: string) => `cindy-media://blobs/${char.repeat(64)}.png`;
    const [a, b] = ['a', 'b'].map(blob);
    const repeated = `![first](${a})\n\n![other](${b})\n\n![again](${a})`;
    const later = `![shown](${b})\n\n![late](out/c.png)`;
    const missing = { status: 'none', candidates: [] };
    const resolvePathBatch = vi.fn(
      async ({ hrefs }: { hrefs: string[] }): Promise<Record<string, unknown>> =>
        Object.fromEntries(hrefs.map((href) => [href, missing])),
    );
    (window as unknown as { electronAPI?: unknown }).electronAPI = { resolvePathBatch };
    try {
      const options = {
        cache: new Map(),
        workingDir: '/work',
        allowPrivilegedLinks: true,
        remoteMediaOrigin: undefined,
        ownershipPending: false,
        resolveInWorkspace: true,
      };
      const session = { sessionId: 'task', workingDir: '/work', origin: LOCAL_FILE_ORIGIN, localConfirmed: true };
      const mount = (content: string) => {
        const item: RenderItem = { type: 'message', key: 'r', message: { clientId: 'r', role: 'assistant', content } };
        const gallery = collectTaskImageGallery([item], new Map(), options);
        return render(
          React.createElement(ChatSessionFileProvider, {
            value: session,
            children: React.createElement(
              ImageGalleryContext.Provider,
              { value: gallery },
              React.createElement(
                ImageGalleryScopeContext.Provider,
                { value: 'r' },
                React.createElement(MarkdownRenderer, {
                  renderRichAnswers: true,
                  content,
                  workingDir: '/work',
                  currentSessionId: 'task',
                  // As AssistantMessage passes the reply's client id.
                  galleryMessageKey: 'r',
                }),
              ),
            ),
          }),
        );
      };

      // Two component blocks with the identical image node: same text, different sections.
      const imageBlock = (src: string) =>
        '```cindy-ui\n' +
        JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'pic', kind: 'image', props: { src, alt: 'same' } }) +
        '\n```';
      const blocks = mount(`${imageBlock(a)}\n\nbetween\n\n${imageBlock(a)}`);
      fireEvent.click(screen.getAllByRole('button', { name: 'same' })[1]!);
      expect(screen.getByText('2 / 2')).toBeTruthy();
      blocks.unmount();

      const first = mount(repeated);
      fireEvent.click(screen.getByRole('button', { name: 'again' }));
      expect(screen.getByText('3 / 3')).toBeTruthy();
      first.unmount();

      mount(later);
      fireEvent.click(await screen.findByRole('button', { name: 'shown' }));
      fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.media.nextImage') }));
      const viewerImage = () => document.querySelector('.modal-panel img')!;
      await waitFor(() => expect(viewerImage().getAttribute('src')).toBe(toLocalFileUrl('/work/out/c.png')));
      fireEvent.error(viewerImage());
      expect(screen.getByText(i18n.t('chat.media.imageMissing'))).toBeTruthy();

      // The file is written where the reply said; the next check finds it.
      const now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now + 3_000);
      resolvePathBatch.mockResolvedValue({
        'out/c.png': { status: 'unique', candidates: ['/work/out/c.png'], kind: 'file' },
      });
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => expect(screen.queryByText(i18n.t('chat.media.imageMissing'))).toBeNull());
      expect(viewerImage().getAttribute('src')).toBe(toLocalFileUrl('/work/out/c.png'));
    } finally {
      vi.restoreAllMocks();
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
      _clearSmartResolveCache();
    }
  });
});
