/**
 * useWorktreeQueries — 三个一次性 IPC hook（M3）：
 *   - useDetectCwd(cwd, deviceLinkDeviceId?, refreshEpoch?) → 探测当前 cwd 是否合法 git 仓库
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

export interface DetectCwdState {
  data: DetectCwdResp | null;
  loading: boolean;
}

export interface DetectCwdTarget {
  cwd: string;
  deviceLinkDeviceId: string | null;
  /** 同设备/目录的重探代次；变化时旧结果也必须同步失效。 */
  refreshEpoch?: number;
}

export interface DetectCwdSnapshot extends DetectCwdState {
  target: DetectCwdTarget | null;
}

/**
 * 只向当前设备/目录/重探代次暴露同 target 的探测结果。effect 要到 commit 后才会重置
 * state；render 阶段先做同步 fence，切项目、设备或同目标重连后的首帧不会复用旧结果。
 */
export function detectCwdStateForTarget(
  snapshot: DetectCwdSnapshot,
  target: DetectCwdTarget | null,
): DetectCwdState {
  if (!target) return { data: null, loading: false };
  if (
    !snapshot.target
    || snapshot.target.cwd !== target.cwd
    || snapshot.target.deviceLinkDeviceId !== target.deviceLinkDeviceId
    || snapshot.target.refreshEpoch !== target.refreshEpoch
  ) {
    return { data: null, loading: true };
  }
  return { data: snapshot.data, loading: snapshot.loading };
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
  refreshEpoch = 0,
): DetectCwdState {
  const [snapshot, setSnapshot] = useState<DetectCwdSnapshot>({
    target: null,
    data: null,
    loading: false,
  });
  const target: DetectCwdTarget | null = cwd
    ? { cwd, deviceLinkDeviceId: deviceLinkDeviceId ?? null, refreshEpoch }
    : null;

  useEffect(() => {
    if (!cwd) {
      setSnapshot({ target: null, data: null, loading: false });
      return;
    }
    const requestTarget: DetectCwdTarget = {
      cwd,
      deviceLinkDeviceId: deviceLinkDeviceId ?? null,
      refreshEpoch,
    };
    let cancelled = false;
    setSnapshot({ target: requestTarget, data: null, loading: true });
    invokeDetectCwd(cwd, deviceLinkDeviceId)
      .then((data) => {
        if (cancelled) return;
        setSnapshot({ target: requestTarget, data, loading: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        log.warn('[useDetectCwd] failed:', err);
        setSnapshot({ target: requestTarget, data: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, deviceLinkDeviceId, refreshEpoch]);

  return detectCwdStateForTarget(snapshot, target);
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

export interface BranchesTarget {
  baseRepo: string;
  deviceLinkDeviceId: string | null;
}

export interface BranchesSnapshot extends Omit<BranchesState, 'refetch'> {
  target: BranchesTarget | null;
}

export function branchesStateForTarget(
  snapshot: BranchesSnapshot,
  target: BranchesTarget | null,
): Omit<BranchesState, 'refetch'> {
  if (!target) {
    return { branches: [], current: null, loading: false, failed: false };
  }
  if (
    !snapshot.target
    || snapshot.target.baseRepo !== target.baseRepo
    || snapshot.target.deviceLinkDeviceId !== target.deviceLinkDeviceId
  ) {
    return { branches: [], current: null, loading: true, failed: false };
  }
  const { branches, current, loading, failed } = snapshot;
  return { branches, current, loading, failed };
}

/**
 * 拉 baseRepo 的本地分支列表。baseRepo 为 null 时返回空集合。
 * 失败置 failed(hook 不自动重试),由调用方经 refetch() 重拉。
 */
export function useBranches(
  baseRepo: string | null,
  deviceLinkDeviceId?: string | null,
): BranchesState {
  const [snapshot, setSnapshot] = useState<BranchesSnapshot>({
    target: null,
    branches: [],
    current: null,
    loading: false,
    failed: false,
  });
  const [tick, setTick] = useState(0);
  const target: BranchesTarget | null = baseRepo
    ? { baseRepo, deviceLinkDeviceId: deviceLinkDeviceId ?? null }
    : null;

  const refetch = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!baseRepo) {
      setSnapshot({
        target: null,
        branches: [],
        current: null,
        loading: false,
        failed: false,
      });
      return;
    }
    const requestTarget: BranchesTarget = {
      baseRepo,
      deviceLinkDeviceId: deviceLinkDeviceId ?? null,
    };
    let cancelled = false;
    setSnapshot({
      target: requestTarget,
      branches: [],
      current: null,
      loading: true,
      failed: false,
    });
    invokeListBranches(baseRepo, deviceLinkDeviceId)
      .then((res: ListBranchesResp) => {
        if (cancelled) return;
        setSnapshot({
          target: requestTarget,
          branches: res.branches ?? [],
          current: res.current ?? null,
          loading: false,
          failed: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        log.warn('[useBranches] failed:', err);
        setSnapshot({
          target: requestTarget,
          branches: [],
          current: null,
          loading: false,
          failed: true,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [baseRepo, deviceLinkDeviceId, tick]);

  return { ...branchesStateForTarget(snapshot, target), refetch };
}

interface SuggestNameState {
  name: string;
  loading: boolean;
  /** 重新拉一次（"换一个"按钮可调）。 */
  regenerate: () => void;
}

export interface SuggestNameTarget {
  baseRepo: string;
  deviceLinkDeviceId: string | null;
}

export interface SuggestNameSnapshot extends Omit<SuggestNameState, 'regenerate'> {
  target: SuggestNameTarget | null;
}

export function suggestNameStateForTarget(
  snapshot: SuggestNameSnapshot,
  target: SuggestNameTarget | null,
): Omit<SuggestNameState, 'regenerate'> {
  if (!target) return { name: '', loading: false };
  if (
    !snapshot.target
    || snapshot.target.baseRepo !== target.baseRepo
    || snapshot.target.deviceLinkDeviceId !== target.deviceLinkDeviceId
  ) {
    return { name: '', loading: true };
  }
  return { name: snapshot.name, loading: snapshot.loading };
}

/**
 * 让 main 生成一个 worktree 名（如 `pensive-lederberg`）。
 * baseRepo 切换会自动重拉一次；用户可调 regenerate() 手动换。
 */
export function useSuggestName(
  baseRepo: string | null,
  deviceLinkDeviceId?: string | null,
): SuggestNameState {
  const [snapshot, setSnapshot] = useState<SuggestNameSnapshot>({
    target: null,
    name: '',
    loading: false,
  });
  const [tick, setTick] = useState(0);
  const target: SuggestNameTarget | null = baseRepo
    ? { baseRepo, deviceLinkDeviceId: deviceLinkDeviceId ?? null }
    : null;

  const regenerate = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!baseRepo) {
      setSnapshot({ target: null, name: '', loading: false });
      return;
    }
    const requestTarget: SuggestNameTarget = {
      baseRepo,
      deviceLinkDeviceId: deviceLinkDeviceId ?? null,
    };
    let cancelled = false;
    setSnapshot({ target: requestTarget, name: '', loading: true });
    invokeSuggestName(baseRepo, deviceLinkDeviceId)
      .then((res: SuggestNameResp) => {
        if (cancelled) return;
        setSnapshot({
          target: requestTarget,
          name: res.name ?? '',
          loading: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        log.warn('[useSuggestName] failed:', err);
        setSnapshot({ target: requestTarget, name: '', loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [baseRepo, deviceLinkDeviceId, tick]);

  return { ...suggestNameStateForTarget(snapshot, target), regenerate };
}
