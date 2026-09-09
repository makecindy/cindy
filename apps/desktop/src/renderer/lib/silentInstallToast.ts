/**
 * silentInstallToast — 监听 main 端 SILENT_INSTALL_STATUS push, 把 maker:send
 * 触发的"远端 agent 没装就自动装"流程, 反馈为右下角一条 toast 的状态机:
 *
 *   started   → loading toast (duration=0, 永久显示) 文案 "正在远端 X 安装 Codex..."
 *   progress  → 按 eventKind 切文案 (toast.update 改副本, 不重发动画 / 不重置 duration)
 *               - node-install-start / node-download / node-extract → "正在准备远端运行时..."
 *               - install-start / install-log / install-done       → "正在远端 X 安装 Codex..."
 *               - 其它                                              → 不更新, 保留上次文案
 *   done      → toast.dismiss (静默结束, 不弹 success 干扰 chat 继续显示流式响应)
 *   failed    → toast.dismiss + 弹 error toast (duration 8s, 文案引导用户去
 *               Settings → 远端机器 → 展开 host 看完整 install log)
 *
 * (hostId, agentKind) 双键 → toast id 的 Map, 支持多台 host 并发 install (理论上
 * maker:send 串行, 但用户开两个 maker session 给两台不同 remote 发消息可以并发)。
 *
 * 复用 systemNetworkErrorToast.ts 的 install pattern: renderer 启动期挂一次,
 * 返回 unsubscribe 给 useEffect cleanup。
 */

import { i18n } from '@/i18n';

import { toast } from './toast';

const TOAST_DURATION_FAILED_MS = 8000;

interface ToastKey {
  hostId: string;
  agentKind: 'codex' | 'claude-code' | 'pi';
}

function makeKey(k: ToastKey): string {
  return `${k.hostId}::${k.agentKind}`;
}

/** in-flight toast id 表; phase=started 写入, done/failed 清除。 */
const activeToastIds = new Map<string, string>();

function friendlyAgentName(agentKind: 'codex' | 'claude-code' | 'pi'): string {
  if (agentKind === 'codex') return 'Codex';
  if (agentKind === 'pi') return 'Pi';
  return 'Claude Code';
}

/**
 * 根据上一条 InstallProgressEvent.kind 决定 toast 副文案。only 切到两个"明显
 * 阶段"避免抖动; 其它 kind 不改文案 (返回 null = "保持上次")。
 */
function phaseText(eventKind: string | undefined, hostId: string, agentKind: 'codex' | 'claude-code' | 'pi'): string | null {
  switch (eventKind) {
    case 'node-install-start':
    case 'node-download':
    case 'node-extract':
      return i18n.t('settings.remote.silentInstall.preparingRuntime', { hostId });
    case 'install-start':
    case 'install-log':
    case 'install-done':
      return i18n.t('settings.remote.silentInstall.installingAgent', {
        hostId,
        agent: friendlyAgentName(agentKind),
      });
    default:
      return null;
  }
}

/**
 * 收到 SILENT_INSTALL_STATUS push 时调用。导出供测试 + 监听桩。
 */
export function handleSilentInstallStatus(payload: RemoteAgentSilentInstallStatusPush): void {
  const key = makeKey(payload);
  const existingId = activeToastIds.get(key);

  switch (payload.phase) {
    case 'started': {
      // started 偶发被重复推 (主线程 broadcast 到多窗口) — 已有 toast 就不重弹。
      if (existingId) return;
      const msg = i18n.t('settings.remote.silentInstall.starting', {
        hostId: payload.hostId,
        agent: friendlyAgentName(payload.agentKind),
      });
      const id = toast.success(msg, { duration: 0 });
      activeToastIds.set(key, id);
      return;
    }
    case 'progress': {
      if (!existingId) return; // 没有对应 toast (started 错过 / 已 dismiss), 忽略
      const next = phaseText(payload.eventKind, payload.hostId, payload.agentKind);
      if (next) toast.update(existingId, next);
      return;
    }
    case 'done': {
      if (existingId) {
        toast.dismiss(existingId);
        activeToastIds.delete(key);
      }
      return;
    }
    case 'failed': {
      if (existingId) {
        toast.dismiss(existingId);
        activeToastIds.delete(key);
      }
      const failedMsg = i18n.t('settings.remote.silentInstall.failed', {
        hostId: payload.hostId,
        agent: friendlyAgentName(payload.agentKind),
        message: payload.message ?? '',
      });
      toast.error(failedMsg, { duration: TOAST_DURATION_FAILED_MS });
      return;
    }
  }
}

/**
 * 在 renderer 启动期挂一次。返回 unsubscribe 给 useEffect cleanup, 但实际生命
 * 周期等于 renderer 进程, 解绑只在 HMR 走。
 */
export function installSilentInstallToastListener(): () => void {
  return window.electronAPI.remoteSsh.onSilentInstallStatus(handleSilentInstallStatus);
}
