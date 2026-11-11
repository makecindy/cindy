import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useEnvCheck } from '@/contexts/EnvCheckContext';
import { createLogger } from '@/lib/logger';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';

/**
 * AppShellCover — 启动 / 登录后进入主界面之前的不透明加载盖。
 *
 * DESIGN.md §10: splash 必须完全遮蔽已挂载 UI，直到加载完成。LocalDbGate 以前
 * 假定这段等待 <100ms、交给 splash 兜底；一旦 ensureReady 慢于 splash 3s 地板，
 * 品牌层卸掉后 gate 仍返回 null，窗口就露出默认白底。
 *
 * 本 context 把「已可进应用但主功能区还不能画」收成一个 coverHeld：
 * splash / 品牌层在 coverHeld 期间不得退场；副窗不走 splash，也不持盖。
 */
export type LocalDbGateStatus = 'pending' | 'ready' | 'fatal';
export type StartupTarget = 'splash' | 'login' | 'app' | 'database-error';
export interface LocalDbOwnerStamp {
  dataOwnerId: string | null;
  ownerGeneration: number;
}
const log = createLogger('app-shell-cover');

export interface AppShellCoverContextValue {
  /** 主界面还不能画，启动 / 登录加载盖必须留着。 */
  coverHeld: boolean;
  startupTarget: StartupTarget;
  localDbGateStatus: LocalDbGateStatus;
  reportLocalDbGate: (status: LocalDbGateStatus) => void;
}

const AppShellCoverContext = createContext<AppShellCoverContextValue | null>(null);

const FALLBACK_VALUE: AppShellCoverContextValue = Object.freeze({
  coverHeld: false,
  startupTarget: 'splash',
  localDbGateStatus: 'pending',
  reportLocalDbGate: () => {},
});

function isDerivedWindow(): boolean {
  return isSecondaryWindow() || isSidebarWindow();
}

export function AppShellCoverProvider({ children }: { children: ReactNode }) {
  const { isInitializing, canEnterApp, ownerBoundaryPending, dataOwnerId, dataOwnerGeneration } = useAuth();
  const { status: envStatus } = useEnvCheck();
  const [dbResult, setDbResult] = useState<{ status: LocalDbGateStatus; owner: LocalDbOwnerStamp } | null>(null);
  const localDbGateStatus = dbResult && dbResult.owner.dataOwnerId === dataOwnerId
    && dbResult.owner.ownerGeneration === dataOwnerGeneration ? dbResult.status : 'pending';

  // Capture the owner when the reporter is issued, so every consumer (including
  // the add-account recovery route) reports into its own generation.
  const reportLocalDbGate = useCallback((status: LocalDbGateStatus) => {
    const owner = { dataOwnerId, ownerGeneration: dataOwnerGeneration };
    setDbResult((previous) => {
      // Main generations only advance. Late reports cannot replace a newer owner result.
      if (previous && previous.owner.ownerGeneration > owner.ownerGeneration) return previous;
      return { status, owner };
    });
  }, [dataOwnerId, dataOwnerGeneration]);

  const startupTarget: StartupTarget = envStatus !== 'passed' || isInitializing || ownerBoundaryPending
    ? 'splash'
    : !canEnterApp
      ? 'login'
      : localDbGateStatus === 'fatal'
        ? 'database-error'
        : localDbGateStatus === 'ready' ? 'app' : 'splash';

  useEffect(() => {
    log.info('startup target changed', { target: startupTarget, generation: dataOwnerGeneration });
  }, [startupTarget, dataOwnerGeneration]);

  const value = useMemo<AppShellCoverContextValue>(() => {
    const coverHeld =
      !isDerivedWindow() &&
      !isInitializing &&
      envStatus === 'passed' &&
      startupTarget === 'splash';
    return {
      coverHeld,
      startupTarget,
      localDbGateStatus,
      reportLocalDbGate,
    };
  }, [envStatus, startupTarget, isInitializing, localDbGateStatus, reportLocalDbGate]);

  return <AppShellCoverContext.Provider value={value}>{children}</AppShellCoverContext.Provider>;
}

export function useAppShellCover(): AppShellCoverContextValue {
  return useContext(AppShellCoverContext) ?? FALLBACK_VALUE;
}
