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
 */
import React, { memo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

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
import { collectSessionImageSrcs, type RenderItem } from '../components/chat/MessageStream';
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
});
