import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DesktopQrHandoffDecisionResult,
  DesktopQrHandoffResult,
  DesktopQrHandoffStateResult,
} from '../../../shared/authIpc';

/**
 * 「远程控制 Cindy」弹窗里的扫码登录出码（本机已登录，为手机出码，手机扫码后本机允许）。
 *
 * - 只在弹窗打开且已登录时出码；关闭即作废本地状态，服务端 2 分钟自然过期。
 * - 轮询 2 秒一次，只在等待扫码阶段运行；手机认领后停下等用户决定；到期即停，由用户手动刷新，
 *   不自动续码（单个码最多约 60 次请求）。
 * - 服务端尚未提供扫码接口（老部署）或出码失败时降级为 `unavailable`，弹窗继续展示下载二维码。
 */
export type QrHandoffPhase = 'idle' | 'creating' | 'ready' | 'claimed' | 'deciding' | 'expired' | 'unavailable';

export interface QrHandoffRequester {
  clientType: 'desktop' | 'mobile' | 'web';
  deviceName?: string;
  platform?: string;
}

export interface QrLoginHandoffApi {
  authQrHandoffCreate: () => Promise<DesktopQrHandoffResult>;
  authQrHandoffState: (handoffId: string) => Promise<DesktopQrHandoffStateResult>;
  authQrHandoffDecide: (handoffId: string, approve: boolean) => Promise<DesktopQrHandoffDecisionResult>;
}

export interface QrLoginHandoffState {
  phase: QrHandoffPhase;
  /** 二维码内容：本版本官网下载页 + 一次性登录参数。 */
  payload: string | null;
  requester: QrHandoffRequester | null;
  /** 用户决定后的结果，供弹窗给出一次性提示。 */
  lastDecision: 'approved' | 'denied' | null;
  refresh: () => void;
  decide: (approve: boolean) => void;
}

export const QR_HANDOFF_POLL_INTERVAL_MS = 2_000;

interface Snapshot {
  phase: QrHandoffPhase;
  handoffId: string | null;
  payload: string | null;
  expiresAt: number | null;
  requester: QrHandoffRequester | null;
}

const IDLE: Snapshot = { phase: 'idle', handoffId: null, payload: null, expiresAt: null, requester: null };

export function useQrLoginHandoff(
  active: boolean,
  api: QrLoginHandoffApi | undefined = window.electronAPI,
  now: () => number = Date.now,
): QrLoginHandoffState {
  const [snapshot, setSnapshot] = useState<Snapshot>(IDLE);
  const [lastDecision, setLastDecision] = useState<'approved' | 'denied' | null>(null);
  const generation = useRef(0);

  const create = useCallback(async () => {
    const current = ++generation.current;
    if (!api?.authQrHandoffCreate) {
      setSnapshot({ ...IDLE, phase: 'unavailable' });
      return;
    }
    setSnapshot({ ...IDLE, phase: 'creating' });
    let result: DesktopQrHandoffResult;
    try {
      result = await api.authQrHandoffCreate();
    } catch {
      result = { success: false, code: 'AUTH_REQUEST_FAILED' };
    }
    if (current !== generation.current) return;
    if (!result.success) {
      setSnapshot({ ...IDLE, phase: 'unavailable' });
      return;
    }
    const expiresAt = Date.parse(result.expiresAt);
    setSnapshot({
      phase: 'ready',
      handoffId: result.handoffId,
      payload: result.payload,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + 2 * 60_000,
      requester: null,
    });
  }, [api, now]);

  useEffect(() => {
    if (!active) {
      generation.current += 1;
      setSnapshot(IDLE);
      setLastDecision(null);
      return;
    }
    void create();
  }, [active, create]);

  // 等待扫码阶段轮询；到期、被认领、离开弹窗即停。
  useEffect(() => {
    if (snapshot.phase !== 'ready' || !snapshot.handoffId || !api) return;
    const handoffId = snapshot.handoffId;
    const expiresAt = snapshot.expiresAt ?? 0;
    const current = generation.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled || current !== generation.current) return;
      if (now() >= expiresAt) {
        setSnapshot((previous) => ({ ...previous, phase: 'expired' }));
        return;
      }
      let result: DesktopQrHandoffStateResult | null = null;
      try {
        result = await api.authQrHandoffState(handoffId);
      } catch {
        result = null;
      }
      if (cancelled || current !== generation.current) return;
      if (result?.success) {
        if (result.status === 'expired') {
          setSnapshot((previous) => ({ ...previous, phase: 'expired' }));
          return;
        }
        if (result.status === 'claimed') {
          setSnapshot((previous) => ({ ...previous, phase: 'claimed', requester: result.requester ?? null }));
          return;
        }
        if (result.status === 'approved' || result.status === 'denied') {
          // 已在其它窗口处理过：换一张新码。
          void create();
          return;
        }
      }
      // 单次失败不终止；到期前继续，到期后停在 expired。
      timer = setTimeout(() => void tick(), QR_HANDOFF_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), QR_HANDOFF_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [snapshot.phase, snapshot.handoffId, snapshot.expiresAt, api, create, now]);

  // 等待用户允许 / 拒绝时不再轮询，但仍按到期时间转为过期：手机已超时退出后，电脑不再显示
  // 允许 / 拒绝，而是给出刷新入口。只用本地计时，不发请求。
  useEffect(() => {
    if (snapshot.phase !== 'claimed' || snapshot.expiresAt == null) return;
    const current = generation.current;
    const timer = setTimeout(() => {
      if (current !== generation.current) return;
      setSnapshot((previous) =>
        previous.phase === 'claimed' ? { ...previous, phase: 'expired', requester: null } : previous,
      );
    }, Math.max(0, snapshot.expiresAt - now()));
    return () => clearTimeout(timer);
  }, [snapshot.phase, snapshot.expiresAt, now]);

  const decide = useCallback(
    (approve: boolean) => {
      const handoffId = snapshot.handoffId;
      if (!api || !handoffId || snapshot.phase !== 'claimed') return;
      const current = generation.current;
      setSnapshot((previous) => ({ ...previous, phase: 'deciding' }));
      void (async () => {
        let result: DesktopQrHandoffDecisionResult;
        try {
          result = await api.authQrHandoffDecide(handoffId, approve);
        } catch {
          result = { success: false, code: 'AUTH_REQUEST_FAILED' };
        }
        if (current !== generation.current) return;
        setLastDecision(result.success ? (approve ? 'approved' : 'denied') : null);
        if (!result.success) {
          // 决定未送达（多为码已过期）：停在过期态，由用户刷新后让手机重扫。
          setSnapshot((previous) => ({ ...previous, phase: 'expired', requester: null }));
          return;
        }
        void create();
      })();
    },
    [api, create, snapshot.handoffId, snapshot.phase],
  );

  return {
    phase: snapshot.phase,
    payload: snapshot.payload,
    requester: snapshot.requester,
    lastDecision,
    refresh: () => void create(),
    decide,
  };
}
