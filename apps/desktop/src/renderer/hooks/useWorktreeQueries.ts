/**
 * useWorktreeQueries — 三个一次性 IPC hook（M3）：
 *   - useDetectCwd(cwd, deviceLinkDeviceId?)     → 探测当前 cwd 是否合法 git 仓库
 *   - useBranches(baseRepo, deviceLinkDeviceId?) → 拉分支列表 + current
 *   - useSuggestName(baseRepo, deviceLinkDeviceId?) → 让 main 生成一个友好的 worktree 名
 *
 * 这三个 hook 都遵循同一约定：
 *   - baseRepo / cwd 为 null 时不发起 IPC
 *   - 失败时静默落地：console.warn + 返回空，组件不在 inline render 错误（错误归 toast）
 *   - 组件 unmount 后通过 cancelled flag 防止 setState on unmounted
 *
 * device-link 远程路由：deviceLinkDeviceId 非空时,cwd/baseRepo 是被控端路径,git 探测
 * 必须在被控端执行才有意义（控制端本机 git 对远程路径必然误报"不是 git 仓库"）。
 * 此时同名 worktree:* channel 经 deviceLink.invoke 隧道转发到被控端（allowlist 已收录）。
 * 老被控端无这些 channel → invoke reject（CHANNEL_NOT_ALLOWED）→ 与本机 IPC 失败同款
 * 静默落地,worktree 开关保持不可用降级。
 */

import { useCallback, useEffect, useState } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('UseWorktreeQueries');

import type {
  DetectCwdResp,
  ListBranchesResp,
  SuggestNameResp,
} from '@/lib/worktree.types';

/** 本机走既有 preload API;deviceId 非空走 device-link 隧道到被控端同名 channel。 */
function invokeDetectCwd(cwd: string, deviceId?: string | null): Promise<DetectCwdResp> {
  if (deviceId) {
    return window.electronAPI.deviceLink.invoke(deviceId, 'worktree:detect-cwd', [
      { cwd },
    ]) as Promise<DetectCwdResp>;
  }
  return window.electronAPI.worktreeDetectCwd({ cwd });
}

function invokeListBranches(baseRepo: string, deviceId?: string | null): Promise<ListBranchesResp> {
  if (deviceId) {
    return window.electronAPI.deviceLink.invoke(deviceId, 'worktree:list-branches', [
      { baseRepo },
    ]) as Promise<ListBranchesResp>;
  }
  return window.electronAPI.worktreeListBranches({ baseRepo });
}

function invokeSuggestName(baseRepo: string, deviceId?: string | null): Promise<SuggestNameResp> {
  if (deviceId) {
    return window.electronAPI.deviceLink.invoke(deviceId, 'worktree:suggest-name', [
      { baseRepo },
    ]) as Promise<SuggestNameResp>;
  }
  return window.electronAPI.worktreeSuggestName({ baseRepo });
}

interface DetectCwdState {
  data: DetectCwdResp | null;
  loading: boolean;
}

/**
 * 探测一个 cwd 是否：
 *   1. 已安装 git
 *   2. 是 git 仓库
 *   3. 已经身处 worktree 内（嵌套需要禁用）
 *
 * cwd 为空字符串 → 视作未选择目录，不拉。
 */
export function useDetectCwd(
  cwd: string | null | undefined,
  deviceLinkDeviceId?: string | null,
): DetectCwdState {
  const [state, setState] = useState<DetectCwdState>({
    data: null,
    loading: false,
  });

  useEffect(() => {
    if (!cwd) {
      setState({ data: null, loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    invokeDetectCwd(cwd, deviceLinkDeviceId)
      .then((data) => {
        if (cancelled) return;
        setState({ data, loading: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        log.warn('[useDetectCwd] failed:', err);
        setState({ data: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, deviceLinkDeviceId]);

  return state;
}

interface BranchesState {
  branches: string[];
  current: string | null;
  loading: boolean;
  /** true = 上次请求失败(与"仓库没有分支"的空列表区分开,UI 据此给重试入口)。 */
  failed: boolean;
  /** 重新拉一次(与 useSuggestName.regenerate 同款 tick 惯例)。 */
  refetch: () => void;
}

/**
 * 拉 baseRepo 的本地分支列表。baseRepo 为 null 时返回空集合。
 * 失败置 failed(hook 不自动重试),由调用方经 refetch() 重拉。
 */
export function useBranches(
  baseRepo: string | null,
  deviceLinkDeviceId?: string | null,
): BranchesState {
  const [state, setState] = useState<Omit<BranchesState, 'refetch'>>({
    branches: [],
    current: null,
    loading: false,
    failed: false,
  });
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!baseRepo) {
      setState({ branches: [], current: null, loading: false, failed: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    invokeListBranches(baseRepo, deviceLinkDeviceId)
      .then((res: ListBranchesResp) => {
        if (cancelled) return;
        setState({
          branches: res.branches ?? [],
          current: res.current ?? null,
          loading: false,
          failed: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        log.warn('[useBranches] failed:', err);
        setState({ branches: [], current: null, loading: false, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [baseRepo, deviceLinkDeviceId, tick]);

  return { ...state, refetch };
}

interface SuggestNameState {
  name: string;
  loading: boolean;
  /** 重新拉一次（"换一个"按钮可调）。 */
  regenerate: () => void;
}

/**
 * 让 main 生成一个 worktree 名（如 `pensive-lederberg`）。
 * baseRepo 切换会自动重拉一次；用户可调 regenerate() 手动换。
 */
export function useSuggestName(
  baseRepo: string | null,
  deviceLinkDeviceId?: string | null,
): SuggestNameState {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const regenerate = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!baseRepo) {
      setName('');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    invokeSuggestName(baseRepo, deviceLinkDeviceId)
      .then((res: SuggestNameResp) => {
        if (cancelled) return;
        setName(res.name ?? '');
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        log.warn('[useSuggestName] failed:', err);
        setName('');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseRepo, deviceLinkDeviceId, tick]);

  return { name, loading, regenerate };
}
