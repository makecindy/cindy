/**
 * 任务信息里的 worktree 徽标：认「这条任务开过 / 用过 worktree」，不认路径长什么样。
 *
 *   managed  = Cindy 官方 create 仍登记在 store 里,且目录还是 linked worktree
 *   observed = 本机任务遥测里仍活着的 linked worktree(可回溯,不只最近一次 cwd)
 *
 * 本机 Desktop 专用。SSH / device-link / Mobile 第一期不显示。
 * 侧栏任务信息只读官方 store(共享快照,不每行扫 Git);打开中的任务才回溯遥测。
 * 不写 store、不改变回收。目录没了摘掉徽标。外部 observed 不可 reveal。
 */

import { useEffect, useState } from 'react';

import { groupingWorktreeBaseRepo } from '@cindy/maker-shared/worktree-paths';

import { useWorktreeForSession } from '@/contexts/WorktreeContext';
import type { Session } from '@/lib/ccAgent.types';
import type { GitContextDirSource } from '@/lib/gitContext.types';
import type { DetectCwdResp, WorktreeMeta } from '@/lib/worktree.types';

export interface SessionWorktreeInfo {
  path: string;
  name: string;
  branch: string | null;
  source: 'managed' | 'observed';
  canReveal: boolean;
}

const DETECT_CWD_CHANNEL = 'worktree:detect-cwd';

export function resolveManagedWorktree(
  official: Pick<WorktreeMeta, 'path' | 'name' | 'branch'> | null,
): SessionWorktreeInfo | null {
  if (!official?.path) return null;
  return {
    path: official.path,
    name: official.name || pathBasename(official.path),
    branch: official.branch ?? null,
    source: 'managed',
    canReveal: true,
  };
}

/** 只有 tool-use 遥测指向 linked worktree 才算「任务里开过」；workingDir 兜底不算。 */
export function observedWorktreeFromTelemetry(opts: {
  source: GitContextDirSource;
  workdir: string | null;
  branch: string | null;
  isInsideWorktree: boolean;
}): SessionWorktreeInfo | null {
  if (opts.source !== 'telemetry' || !opts.workdir || !opts.isInsideWorktree) return null;
  return {
    path: opts.workdir,
    name: pathBasename(opts.workdir),
    branch: opts.branch,
    source: 'observed',
    canReveal: false,
  };
}

export function selectDisplayedWorktree(opts: {
  enabled: boolean;
  managed: SessionWorktreeInfo | null;
  officialStillLive: boolean;
  observed: SessionWorktreeInfo | null;
}): SessionWorktreeInfo | null {
  if (!opts.enabled) return null;
  if (opts.managed && opts.officialStillLive) return opts.managed;
  return opts.observed;
}

export function pathBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** 聊天框底部 workingDir chip: `repo (worktree)`；认不出 base repo 时只显示短名。 */
export function formatWorktreeChipText(info: SessionWorktreeInfo): string {
  const base = groupingWorktreeBaseRepo(info.path);
  if (base) return `${pathBasename(base)} (${info.name})`;
  return info.name;
}

/** chip 文案、hover、打开目录共用这一条路径,避免显示 worktree 却打开主仓。远端仍用 session.workingDir。 */
export function composerWorkingDirPath(opts: {
  workingDir: string | null | undefined;
  liveWorktree: SessionWorktreeInfo | null;
  isRemote: boolean;
}): string | null {
  if (opts.isRemote) return opts.workingDir ?? null;
  return opts.liveWorktree?.path ?? opts.workingDir ?? null;
}

export function useTaskInfoWorktree(
  session: Pick<
    Session,
    'id' | 'workingDir' | 'worktreePath' | 'deviceLinkDeviceId' | 'remoteHostId'
  >,
  enabled: boolean,
  opts?: { observeTelemetry?: boolean },
): SessionWorktreeInfo | null {
  const official = useWorktreeForSession(session.id);
  const managed = resolveManagedWorktree(official);
  const [observed, setObserved] = useState<SessionWorktreeInfo | null>(null);
  const [officialStillLive, setOfficialStillLive] = useState(true);
  const officialPath = official?.path ?? null;
  const deviceId = session.deviceLinkDeviceId ?? null;
  const isRemote = Boolean(deviceId || session.remoteHostId);
  const observeTelemetry = Boolean(opts?.observeTelemetry);

  useEffect(() => {
    setObserved(null);
    if (!enabled || isRemote || !observeTelemetry) {
      setOfficialStillLive(!isRemote);
      return;
    }
    let cancelled = false;
    let generation = 0;
    let inflight: Promise<void> | null = null;
    let queued = false;
    const refreshOnce = async () => {
      const gen = ++generation;
      if (officialPath) {
        const live = await probeIsInsideWorktree(officialPath, deviceId);
        if (cancelled || gen !== generation) return;
        setOfficialStillLive(live);
        if (live) {
          setObserved(null);
          return;
        }
      } else if (gen === generation) {
        setOfficialStillLive(false);
      }
      if (isRemote) {
        if (!cancelled && gen === generation) setObserved(null);
        return;
      }
      const next = await discoverObservedWorktree(session.id);
      if (!cancelled && gen === generation) setObserved(next);
    };
    const refresh = () => {
      if (inflight) {
        queued = true;
        return inflight;
      }
      inflight = refreshOnce().finally(() => {
        inflight = null;
        if (cancelled) return;
        if (queued) {
          queued = false;
          void refresh();
        }
      });
      return inflight;
    };
    void refresh();
    const unsubscribe = window.electronAPI.onWorktreeChanged?.(() => {
      void refresh();
    });
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, officialPath, deviceId, isRemote, observeTelemetry, session.id]);

  if (isRemote) return null;
  if (!observeTelemetry) {
    return selectDisplayedWorktree({
      enabled,
      managed,
      officialStillLive: true,
      observed: null,
    });
  }
  return selectDisplayedWorktree({
    enabled,
    managed,
    officialStillLive,
    observed,
  });
}

async function probeIsInsideWorktree(cwd: string, deviceId: string | null): Promise<boolean> {
  try {
    const detect: DetectCwdResp = deviceId
      ? ((await window.electronAPI.deviceLink.invoke(deviceId, DETECT_CWD_CHANNEL, [
          { cwd },
        ])) as DetectCwdResp)
      : await window.electronAPI.worktreeDetectCwd({ cwd });
    return Boolean(detect?.isInsideWorktree);
  } catch {
    return false;
  }
}

async function discoverObservedWorktree(sessionId: string): Promise<SessionWorktreeInfo | null> {
  try {
    const found = await window.electronAPI.gitContext.findLinkedWorktree({ sessionId });
    if (!found?.workdir) return null;
    return observedWorktreeFromTelemetry({
      source: 'telemetry',
      workdir: found.workdir,
      branch: found.branch,
      isInsideWorktree: true,
    });
  } catch {
    return null;
  }
}
