import { useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useAppShellCover } from '@/contexts/AppShellCoverContext';
import { useAuth } from '@/contexts/AuthContext';
import { LocalDbFatalScreen } from '@/components/error/LocalDbFatalScreen';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';

const log = createLogger('LocalDbGate');
const shownDbSlimmingResultIds = new Set<string>();

/**
 * 路由层 localDb 就绪门（前身 MigrationGate；chat-data 云端迁移已随主 server
 * 退役，本组件只保留"库就绪"职责）：
 *
 * - 入口已经过 ProtectedRoute（已认证）；这里只判断"主功能区是否可进入"。
 * - 调 `localDb.ensureReady(userId)`——按 userId 切换 / 兜底恢复 / 跑 schema
 *   migration。成功后渲染主功能 Outlet；失败：渲染 LocalDbFatalScreen 全屏
 *   恢复界面（MIGRATE_FAILED 时 main 不再弹 OS 对话框，恢复路径是安装已暂存
 *   的应用更新；其余 code 原生对话框照旧，本界面兜底展示错误详情）。
 * - ensureReady 成功后向 main 发 appReadyForBot 信号（IM bot 连接安全上线的
 *   前置条件），fire-and-forget。
 */
type GateDecision =
  | { phase: 'checking' }
  | { phase: 'ready' }
  | { phase: 'fatal'; code?: string; message?: string };

/**
 * decision 失败的有限重试。fatal 会切到全屏恢复界面、阻断整棵主功能 UI 树,必须
 * 只留给确定性失败;而这里的失败常常是 transient —— 2026-07-15 实锤过一例:
 * 跨系统睡眠的 db worker RPC 假超时把 ensureReady 打挂,一次挫折直接白屏到手动
 * Cmd+R。重试 2 次(间隔 1s)可消化这类瞬时故障,真死的 DbClient 依然会在
 * 第 3 次失败后落 fatal,保住"不永久停在 checking"的原有保证。
 */
const MAX_DECISION_RETRIES = 2;
const DECISION_RETRY_DELAY_MS = 1_000;

export function LocalDbGate() {
  const { t } = useTranslation();
  const { dataOwnerId, mode, logout, exitLocalMode } = useAuth();
  const { reportLocalDbGate } = useAppShellCover();
  const navigate = useNavigate();
  const [decision, setDecision] = useState<GateDecision>({ phase: 'checking' });
  const [retryNonce, setRetryNonce] = useState(0);
  const retryCountRef = useRef(0);
  const previousOwnerIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const ownerId = dataOwnerId;
    const ownerChanged = previousOwnerIdRef.current !== ownerId;
    previousOwnerIdRef.current = ownerId;
    // user 变化 = 一次全新决策,重试额度整体归零;只有 retryNonce 驱动的重跑才
    // 继承计数(否则重试永远数不满,fatal 不可达)。
    if (ownerChanged) {
      retryCountRef.current = 0;
      setDecision({ phase: 'checking' });
    }
    if (!ownerId) {
      return () => {
        cancelled = true;
      };
    }

    (async () => {
     const attemptStartedAt = performance.now();
     try {
      // ensureReady（按 userId 切换 db；失败 main 已弹对话框）
      const ready = await window.electronAPI.localDb.ensureReady(ownerId);
      if (cancelled) return;
      if (!ready.ready) {
        log.error('ensureReady failed', ready.error);
        setDecision({ phase: 'fatal', code: ready.error.code, message: ready.error.message });
        return;
      }

      log.info('startup readiness reached', {
        event: 'renderer.local-db-gate.ready',
        elapsedMs: Math.round(performance.now() - attemptStartedAt),
        rendererUptimeMs: Math.round(performance.now()),
      });

      try {
        const maintenanceResult = await window.electronAPI.localDb.maintenance.getLastResult();
        if (
          maintenanceResult &&
          !shownDbSlimmingResultIds.has(maintenanceResult.id)
        ) {
          shownDbSlimmingResultIds.add(maintenanceResult.id);
          if (maintenanceResult.status === 'completed') {
            toast.success(
              t('settings.about.storage.dbSlimmingToastCompleted', {
                size: formatBytes(maintenanceResult.reclaimedBytes),
              }),
            );
          } else {
            toast.error(
              t(`settings.about.storage.dbSlimmingFailure.${maintenanceResult.reason}`, {
                defaultValue: t('settings.about.storage.dbSlimmingFailure.unknown'),
              }),
            );
          }
        }
      } catch (error) {
        log.warn('database slimming result read failed (non-fatal)', error);
      }

      // Signal main "user logged in + localDb is open" so account integrations can
      // come online after provider discovery. Gated and idempotent in main — re-mounts
      // and account switches are no-ops after the first call.
      // Fire-and-forget: the gate decision below MUST NOT block on bot startup.
      void window.electronAPI.appReadyForBot().catch((err) => {
        log.warn('appReadyForBot signal failed (non-fatal)', err);
      });

      retryCountRef.current = 0;
      setDecision({ phase: 'ready' });
     } catch (err) {
       // ensureReady IPC reject（典型：DbClient 未就绪）不能让 async 异常静默
       // 冒泡、decision 永远停在 'checking' → 永久黑屏。但一次挫折也不能直接
       // fatal(见 MAX_DECISION_RETRIES 注释):先有限重试,耗尽才 fatal。
       if (cancelled) return;
       if (retryCountRef.current < MAX_DECISION_RETRIES) {
         retryCountRef.current += 1;
         log.warn(
           `local-db gate decision failed, retrying (${retryCountRef.current}/${MAX_DECISION_RETRIES})`,
           err,
         );
         retryTimer = setTimeout(() => setRetryNonce((n) => n + 1), DECISION_RETRY_DELAY_MS);
         return;
       }
       log.error('local-db gate decision failed after retries', err);
       setDecision({ phase: 'fatal', message: err instanceof Error ? err.message : String(err) });
     }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
    // 依赖 user.id——切账号 blank;同账号 refresh 不因对象引用变化卸载 Outlet。
    // retryNonce 驱动失败后的有限重试重跑。
  }, [dataOwnerId, retryNonce, t]);

  useEffect(() => {
    if (!dataOwnerId || decision.phase === 'checking') {
      reportLocalDbGate('pending');
    } else if (decision.phase === 'fatal') {
      reportLocalDbGate('fatal');
    } else {
      reportLocalDbGate('ready');
    }
    return () => {
      reportLocalDbGate('pending');
    };
  }, [dataOwnerId, decision, reportLocalDbGate]);

  if (!dataOwnerId || decision.phase === 'checking') {
    // 主界面还不能画。视觉盖由 AppShellCover + Splash / 品牌层承接
    // (DESIGN.md §10),这里返回 null 避免先露出空壳再盖上。
    return null;
  }

  if (decision.phase === 'fatal') {
    // 全屏恢复界面接管：阻断主功能区渲染，并给出「重启并安装更新」等恢复路径。
    return (
      <LocalDbFatalScreen
        code={decision.code}
        message={decision.message}
        onBackToLogin={() => {
          const leave = mode === 'local' ? exitLocalMode() : logout();
          void leave.then(
            () => navigate('/login', { replace: true }),
            (err) => {
              // The fatal screen must always have an escape hatch. A failed
              // teardown is still logged, but must not trap the user here.
              log.warn('failed to leave the current session from local-db fatal screen', err);
              navigate('/login', { replace: true });
            },
          );
        }}
      />
    );
  }

  return <Outlet />;
}
