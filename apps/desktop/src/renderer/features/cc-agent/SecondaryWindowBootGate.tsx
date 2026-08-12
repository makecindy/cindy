/**
 * SecondaryWindowBootGate — 「在新窗口打开」副窗的启动路由网关。
 * ---------------------------------------------------------------------------
 * main/secondary-windows.ts 开副窗时不再写死 `/cc-agent/<id>`,而是把目标
 * sessionId 放进启动参数 `?bootSession=<id>` 并落到本网关路由 `/cc-agent/boot`。
 * 本组件读出 bootSession,经 resolveSessionRoute 解析出 canonical route(普通会话
 * `/cc-agent/<id>` / Orca lead `/cc-agent/<id>` / worker
 * `/cc-agent/<leadId>?worker=<id>`),再 navigate(replace) 过去。
 *
 * 为什么要这一层(对照评论 F2):
 *   - 角色 → 路由的解析逻辑单一来源留在 renderer(resolveSessionRoute),main 不
 *     复刻角色查询(DRY,且 worker 还要查 leadSessionId)。
 *   - 首屏即落到正确路由:解析完成前停在本中性网关(不渲染任何 session 视图),
 *     避免先渲染 worker 单会话再回到 lead 的视觉跳变(规则 7)。
 *   - 本网关与目标路由同属 CCAgentFeatureLayout,navigate 时 feature layout 不重挂,
 *     只换 Outlet 子节点,无 feature 级淡入重跑。
 *
 * 解析期间(resolveSessionRoute 内部要 await IPC,worker 还要查 getByWorkerSession)
 * 渲染中性占位(content-area 底色),不出现空白帧。bootSession 缺失时回落 /cc-agent。
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { getBootDeviceId, getBootSessionId } from '@/lib/secondaryWindow';
import { getSessionFor } from '@/lib/makerTransport';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { createLogger } from '@/lib/logger';

const log = createLogger('SecondaryWindowBootGate');

export function SecondaryWindowBootGate() {
  const navigate = useNavigate();
  // 只 boot 一次:StrictMode(dev)下 effect 跑两次,ref 守住避免重复解析 / 跳转。
  const hasBootedRef = useRef(false);

  useEffect(() => {
    if (hasBootedRef.current) return;
    hasBootedRef.current = true;

    const bootSessionId = getBootSessionId();
    if (!bootSessionId) {
      // 异常进入(直接打开 /cc-agent/boot 而无 bootSession)→ 回落默认入口。
      navigate('/cc-agent', { replace: true });
      return;
    }

    let cancelled = false;
    const bootDeviceId = getBootDeviceId();
    void (async () => {
      if (!bootDeviceId) return resolveSessionRoute(bootSessionId);

      // The remote session is not in the local DB. Pin its origin before any
      // metadata read so getSessionFor tunnels to the owning device even when
      // the secondary window's remote mirror has not hydrated yet.
      remoteProjectsStore.pinSessionOrigin(bootDeviceId, bootSessionId);
      const mirroredSession = remoteProjectsStore
        .getMergedRemoteSessions()
        .find((session) => session.id === bootSessionId);
      const remoteSession = mirroredSession ?? (await getSessionFor(bootSessionId));
      return resolveSessionRoute(bootSessionId, remoteSession);
    })()
      .then((target) => {
        if (cancelled) return;
        navigate(target, { replace: true });
      })
      .catch((err) => {
        log.warn('failed to resolve boot session route, falling back to /cc-agent', {
          bootSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!cancelled) navigate('/cc-agent', { replace: true });
      });

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // 中性占位:解析完成前不渲染任何 session 视图,只铺 content-area 底色撑满,
  // 避免空白帧 / 单栏闪现(规则 12)。
  return <div className="h-full w-full bg-content-area" />;
}
