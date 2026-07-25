// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAllFiles: vi.fn(),
}));

vi.mock('@/lib/fileBrowserTransport', () => ({
  fileBrowserApiFor: () => ({
    listAllFiles: mocks.listAllFiles,
  }),
}));

import { _resetProjectFileListCache, useProjectFileList } from '../useProjectFileList';

type HookProps = {
  workdir: string;
  enabled?: boolean;
};

function renderList(initial: HookProps) {
  return renderHook(
    ({ workdir, enabled }: HookProps) =>
      useProjectFileList(workdir, null, null, enabled === undefined ? undefined : { enabled }),
    { initialProps: initial },
  );
}

function listResult(files: string[], truncated = false) {
  return { files, truncated, elapsedMs: 5 };
}

describe('useProjectFileList', () => {
  beforeEach(() => {
    _resetProjectFileListCache();
    mocks.listAllFiles.mockReset();
    mocks.listAllFiles.mockResolvedValue(listResult(['a.ts', 'src/b.ts']));
    // hook 用 window.electronAPI 存在性判断 IPC 可用;实际调用走被 mock 的
    // fileBrowserApiFor,这里只需要占位真值。
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      fileBrowser: { listAllFiles: () => undefined },
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('不传 options 时保持旧语义:挂载即拉', async () => {
    const { result } = renderList({ workdir: '/repo' });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);
    expect(result.current.files).toEqual(['a.ts', 'src/b.ts']);
  });

  it('enabled=false 时不发 IPC,不进入 loading', () => {
    const { result } = renderList({ workdir: '/repo', enabled: false });
    expect(mocks.listAllFiles).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.files).toEqual([]);
  });

  it('enabled 翻 true 时才发起首次拉取', async () => {
    const { result, rerender } = renderList({ workdir: '/repo', enabled: false });
    expect(mocks.listAllFiles).not.toHaveBeenCalled();

    rerender({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files).toEqual(['a.ts', 'src/b.ts']));
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);
  });

  it('true→false→true 且缓存新鲜:不重复拉取', async () => {
    const { result, rerender } = renderList({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files.length).toBe(2));

    rerender({ workdir: '/repo', enabled: false });
    rerender({ workdir: '/repo', enabled: true });
    // fresh 缓存直接命中,不新增 IPC。
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);
    expect(result.current.files).toEqual(['a.ts', 'src/b.ts']);
  });

  it('普通快照 30s 过期:重新 enabled 时重拉', async () => {
    const { result, rerender } = renderList({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files.length).toBe(2));

    rerender({ workdir: '/repo', enabled: false });
    vi.setSystemTime(new Date('2026-07-25T12:00:31Z'));
    rerender({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(mocks.listAllFiles).toHaveBeenCalledTimes(2));
  });

  it('truncated 快照放宽到 5 分钟:31s 不重拉,5 分钟后重拉', async () => {
    mocks.listAllFiles.mockResolvedValue(listResult(['a.ts'], true));
    const { result, rerender } = renderList({ workdir: '/big', enabled: true });
    await waitFor(() => expect(result.current.truncated).toBe(true));
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);

    // 31 秒后:普通 TTL 已过,但 truncated 快照仍然有效 → 不重拉。
    rerender({ workdir: '/big', enabled: false });
    vi.setSystemTime(new Date('2026-07-25T12:00:31Z'));
    rerender({ workdir: '/big', enabled: true });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);

    // 超过 5 分钟:truncated TTL 也过期 → 重拉。
    rerender({ workdir: '/big', enabled: false });
    vi.setSystemTime(new Date('2026-07-25T12:05:32Z'));
    rerender({ workdir: '/big', enabled: true });
    await waitFor(() => expect(mocks.listAllFiles).toHaveBeenCalledTimes(2));
  });

  it('refresh 在 enabled=false 时只失效缓存不扫描;下次 enabled 拉新', async () => {
    const { result, rerender } = renderList({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files.length).toBe(2));

    rerender({ workdir: '/repo', enabled: false });
    act(() => {
      result.current.refresh();
    });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1); // 没有新扫描

    rerender({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(mocks.listAllFiles).toHaveBeenCalledTimes(2)); // 缓存已失效 → 拉新
  });

  it('refresh 在 enabled=true 时立即重拉(旧语义)', async () => {
    const { result } = renderList({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files.length).toBe(2));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(mocks.listAllFiles).toHaveBeenCalledTimes(2));
  });

  it('error token(如 RG_UNAVAILABLE)随缓存保留:enabled 翻转 + 缓存命中后不丢', async () => {
    mocks.listAllFiles.mockResolvedValue({ files: [], truncated: false, elapsedMs: 5, error: 'RG_UNAVAILABLE' });
    const { result, rerender } = renderList({ workdir: '/remote', enabled: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('RG_UNAVAILABLE');

    // 清空筛选(enabled=false)再输入(enabled=true,缓存 30s 内命中):error 必须
    // 还原,否则空 files + null error 会把"未索引"占位显示成"无匹配"。
    rerender({ workdir: '/remote', enabled: false });
    expect(result.current.error).toBe('RG_UNAVAILABLE');
    rerender({ workdir: '/remote', enabled: true });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1); // 缓存命中,无新 IPC
    expect(result.current.error).toBe('RG_UNAVAILABLE');
    expect(result.current.files).toEqual([]);
  });

  it('disabled refresh 清空 state:重新 enabled 拉取期间不闪 stale 结果', async () => {
    const { result, rerender } = renderList({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files.length).toBe(2));

    rerender({ workdir: '/repo', enabled: false });
    act(() => {
      result.current.refresh();
    });
    // FilterResultList 只在 files 为空时显示"正在索引"占位,refresh 后必须清空。
    expect(result.current.files).toEqual([]);

    rerender({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(mocks.listAllFiles).toHaveBeenCalledTimes(2));
  });

  it('enabled=true 的 refresh 作废在途请求并发起新扫描,最终展示新快照', async () => {
    let resolveOld!: (v: { files: string[]; truncated: boolean; elapsedMs: number }) => void;
    mocks.listAllFiles.mockImplementationOnce(
      () => new Promise((done) => { resolveOld = done; }),
    );
    const { result } = renderList({ workdir: '/repo', enabled: true });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);

    // 旧请求未完成时点刷新:必须发起第二次扫描(不 piggyback 已失效请求)。
    mocks.listAllFiles.mockResolvedValue(listResult(['fresh.ts']));
    act(() => {
      result.current.refresh();
    });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(2);

    // 旧请求此刻才完成:其结果不得覆盖 state,最终展示的是新快照。
    await act(async () => {
      resolveOld(listResult(['stale.ts']));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.files).toEqual(['fresh.ts']));
  });

  it('piggyback 消费 inflight 的解析值:fetch 失败(不写缓存)时搭车方同样拿到 error', async () => {
    let rejectFetch!: (err: Error) => void;
    mocks.listAllFiles.mockImplementationOnce(
      () => new Promise((_done, fail) => { rejectFetch = fail; }),
    );
    const first = renderList({ workdir: '/repo', enabled: true });
    // 第二个实例在第一个 pending 时挂载:走 piggyback,不发新 IPC。
    const second = renderList({ workdir: '/repo', enabled: true });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectFetch(new Error('boom'));
      await Promise.resolve();
    });
    // 失败结果不进缓存,搭车方必须从 inflight 解析值拿到 error,而不是回读空缓存。
    await waitFor(() => expect(first.result.current.error).toContain('boom'));
    await waitFor(() => expect(second.result.current.error).toContain('boom'));
    expect(second.result.current.isLoading).toBe(false);
  });

  it('另一实例 refresh 时,在途实例不卡 loading,追上新请求的结果', async () => {
    let resolveOld!: (v: { files: string[]; truncated: boolean; elapsedMs: number }) => void;
    mocks.listAllFiles.mockImplementationOnce(
      () => new Promise((done) => { resolveOld = done; }),
    );
    // X 发起请求(pending);Y 共享同一 cacheKey。
    const x = renderList({ workdir: '/repo', enabled: true });
    const y = renderList({ workdir: '/repo', enabled: true });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);

    // Y 触发 refresh:作废在途请求并发起新扫描。
    mocks.listAllFiles.mockResolvedValue(listResult(['fresh.ts']));
    act(() => {
      y.result.current.refresh();
    });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(2);

    // 旧请求此刻完成:X 的回调因失效代数不匹配不能直接丢弃 —— 必须追上新请求,
    // 否则 X 永久停在 isLoading(没有其它回调会再喂它)。
    await act(async () => {
      resolveOld(listResult(['stale.ts']));
      await Promise.resolve();
    });
    await waitFor(() => expect(x.result.current.isLoading).toBe(false));
    expect(x.result.current.files).toEqual(['fresh.ts']);
    await waitFor(() => expect(y.result.current.files).toEqual(['fresh.ts']));
  });

  it('拉取失败回退缓存时保留 truncated 标志', async () => {
    mocks.listAllFiles.mockResolvedValue(listResult(['a.ts'], true));
    const { result, rerender } = renderList({ workdir: '/big', enabled: true });
    await waitFor(() => expect(result.current.truncated).toBe(true));

    // truncated 快照 5 分钟 TTL 过期后重拉失败:回退缓存 files 时"结果过多"
    // 标志不能静默消失 —— 列表仍是截断的。
    rerender({ workdir: '/big', enabled: false });
    vi.setSystemTime(new Date('2026-07-25T12:06:00Z'));
    mocks.listAllFiles.mockRejectedValueOnce(new Error('boom'));
    rerender({ workdir: '/big', enabled: true });
    await waitFor(() => expect(result.current.error).toContain('boom'));
    expect(result.current.files).toEqual(['a.ts']);
    expect(result.current.truncated).toBe(true);
  });

  it('refresh 期间完成的在途请求不得把旧快照写回缓存', async () => {
    let resolveFetch!: (v: { files: string[]; truncated: boolean; elapsedMs: number }) => void;
    mocks.listAllFiles.mockImplementationOnce(
      () => new Promise((done) => { resolveFetch = done; }),
    );
    const { result, rerender } = renderList({ workdir: '/repo', enabled: true });
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(1);

    // 拉取尚未完成时用户清空筛选并点了树刷新(失效缓存)。
    rerender({ workdir: '/repo', enabled: false });
    act(() => {
      result.current.refresh();
    });
    // 在途请求此刻才完成:结果已因失效代数不匹配而不进缓存。
    await act(async () => {
      resolveFetch(listResult(['stale.ts']));
      await Promise.resolve();
    });

    // 重新 enabled:缓存里没有可复用的快照 → 必须重新拉,而不是复用 stale.ts。
    mocks.listAllFiles.mockResolvedValue(listResult(['fresh.ts']));
    rerender({ workdir: '/repo', enabled: true });
    await waitFor(() => expect(result.current.files).toEqual(['fresh.ts']));
    expect(mocks.listAllFiles).toHaveBeenCalledTimes(2);
  });
});
