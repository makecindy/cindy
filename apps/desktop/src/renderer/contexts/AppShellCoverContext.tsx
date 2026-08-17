import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { isGhostPanelWindow } from '@/lib/ghostPanelWindow';
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

export interface AppShellCoverContextValue {
  /** 主界面还不能画，启动 / 登录加载盖必须留着。 */
  coverHeld: boolean;
  localDbGateStatus: LocalDbGateStatus;
  reportLocalDbGate: (status: LocalDbGateStatus) => void;
}

const AppShellCoverContext = createContext<AppShellCoverContextValue | null>(null);

const FALLBACK_VALUE: AppShellCoverContextValue = Object.freeze({
  coverHeld: false,
  localDbGateStatus: 'pending',
  reportLocalDbGate: () => {},
});

function isDerivedWindow(): boolean {
  return isSecondaryWindow() || isSidebarWindow() || isGhostPanelWindow();
}

export function AppShellCoverProvider({ children }: { children: ReactNode }) {
  const { isInitializing, canEnterApp } = useAuth();
  const [localDbGateStatus, setLocalDbGateStatus] = useState<LocalDbGateStatus>('pending');

  const reportLocalDbGate = useCallback((status: LocalDbGateStatus) => {
    setLocalDbGateStatus(status);
  }, []);

  const value = useMemo<AppShellCoverContextValue>(() => {
    const coverHeld =
      !isDerivedWindow() &&
      !isInitializing &&
      canEnterApp &&
      localDbGateStatus === 'pending';
    return {
      coverHeld,
      localDbGateStatus,
      reportLocalDbGate,
    };
  }, [canEnterApp, isInitializing, localDbGateStatus, reportLocalDbGate]);

  return <AppShellCoverContext.Provider value={value}>{children}</AppShellCoverContext.Provider>;
}

export function useAppShellCover(): AppShellCoverContextValue {
  return useContext(AppShellCoverContext) ?? FALLBACK_VALUE;
}
