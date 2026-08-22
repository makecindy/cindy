// @vitest-environment jsdom

/**
 * 「打开交付物」的失败面。
 *
 * 空头支票复核 2026-08-19:协议引用类交付物(item.ref)走
 * `openMediaWithDefaultApp`,而主进程对这些地址会在**日常情况**下抛错 ——
 * 交付的 pdf / xlsx(非图片扩展名的 xdt-file://)、xdt-video:// 之类主进程不认的
 * 方案、以及 blob 已被回收的 cindy-media://。调用方全是 `void openArtifact(...)`,
 * renderer 又没有全局 unhandledrejection 兜底,所以这里不接住的话,用户点「打开」
 * 就是**什么都不发生、也没有任何提示** —— 一个哑巴按钮。
 *
 * 这组用例钉住:失败必须出 toast,成功必须不出。
 */

import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBotArtifact } from '../../../../shared/botArtifact';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  openMediaWithDefaultApp: vi.fn(async (_input: { url: string }) => undefined),
}));

vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/components/chat/ChatSessionFileContext', () => ({
  useChatSessionFile: () => ({ origin: null, workingDir: '/work' }),
}));
vi.mock('@/lib/localPathResolver', () => ({
  toLocalFileUrl: (p: string) => `file://${p}`,
}));
vi.mock('@/lib/sessionFileOrigin', () => ({
  isRemoteFileOrigin: () => false,
  toRemoteMediaOrigin: () => null,
}));

// 动态 import 的两个 lightbox：本组用例只走 ref 非图片分支，不会真的渲染它们。
vi.mock('@/components/chat/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/components/chat/TextLightbox', () => ({ TextLightbox: () => null }));

import { useBotArtifactOpen } from '../useBotArtifactOpen';

function refArtifact(ref: string) {
  return makeBotArtifact({
    source: 'delegation',
    target: ref,
    isRef: true,
    createdAt: Date.now(),
    sessionId: 'child-1',
    delegationId: 'd-1',
  });
}

beforeEach(() => {
  mocks.toastError.mockClear();
  mocks.openMediaWithDefaultApp.mockClear();
  mocks.openMediaWithDefaultApp.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      openMediaWithDefaultApp: (input: { url: string }) => mocks.openMediaWithDefaultApp(input),
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useBotArtifactOpen —— 协议引用类交付物', () => {
  it('打开成功时不打扰用户', async () => {
    const { result } = renderHook(() => useBotArtifactOpen());
    const item = refArtifact('xdt-file://abc?path=/tmp/report.pdf');

    await act(async () => {
      await result.current.openArtifact(item);
    });

    expect(mocks.openMediaWithDefaultApp).toHaveBeenCalledWith({ url: item.ref });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('主进程说不出这是什么地址时，如实报错而不是静默吞掉', async () => {
    mocks.openMediaWithDefaultApp.mockRejectedValue(new Error('not a local media source'));
    const { result } = renderHook(() => useBotArtifactOpen());

    await act(async () => {
      await result.current.openArtifact(refArtifact('xdt-video://abc'));
    });

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError.mock.calls[0][0]).toContain('not a local media source');
  });

  it('文件已经被回收时也要给提示', async () => {
    mocks.openMediaWithDefaultApp.mockRejectedValue(new Error('文件不存在'));
    const { result } = renderHook(() => useBotArtifactOpen());

    await act(async () => {
      await result.current.openArtifact(refArtifact('cindy-media://blobs/deadbeef.pdf'));
    });

    expect(mocks.toastError).toHaveBeenCalledWith('文件不存在');
  });

  it('拿不到具体原因时退到通用文案，但一定要出声', async () => {
    mocks.openMediaWithDefaultApp.mockRejectedValue({});
    const { result } = renderHook(() => useBotArtifactOpen());

    await act(async () => {
      await result.current.openArtifact(refArtifact('xdt-model://abc'));
    });

    expect(mocks.toastError).toHaveBeenCalledWith('logic.errors.openFileFailed');
  });

  it('openArtifact 本身不再向调用方抛错（调用方都是 void 调用）', async () => {
    mocks.openMediaWithDefaultApp.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useBotArtifactOpen());

    await expect(
      act(async () => {
        await result.current.openArtifact(refArtifact('xdt-audio://abc'));
      }),
    ).resolves.not.toThrow();
  });
});
