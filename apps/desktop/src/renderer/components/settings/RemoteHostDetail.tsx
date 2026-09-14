/**
 * RemoteHostDetail — Phase B per-host expandable detail.
 *
 * Shown under a host row when the user expands it AND the host is in
 * `ready` status. Surfaces two things:
 *   1. Agent install state (Claude Code + Codex), with Install / Reinstall /
 *      Uninstall actions and live progress log during install.
 *   2. Quick test — send a short prompt to one of the installed agents,
 *      show its full stdout. Smoke-tests the SSH pipe + agent install
 *      end-to-end.
 *
 * Phase B explicitly does NOT integrate with maker's session orchestration;
 * that's Phase C (RemoteAgent as a BaseAgent subclass).
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, AlertCircle, Play, Upload, Sparkles, Waypoints } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import * as sessionService from '@/lib/sessionService';
import { buildCodexSyncWarning } from '@/utils/codexAuthSync';
import { remoteSshHostsStore } from '@/lib/remoteSshHostsStore';

type AgentKind = RemoteAgentKind;
const AGENT_KINDS: ReadonlyArray<AgentKind> = ['claude-code', 'codex', 'pi'];

interface AgentRowState {
  loading: boolean;
  probe: RemoteAgentProbe | null;
  installing: boolean;
  installLog: string[];
}

const EMPTY_AGENT_STATE: AgentRowState = {
  loading: false,
  probe: null,
  installing: false,
  installLog: [],
};

interface Props {
  hostId: string;
}

export function RemoteHostDetail({ hostId }: Props) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [agents, setAgents] = useState<Record<AgentKind, AgentRowState>>(() => ({
    'claude-code': { ...EMPTY_AGENT_STATE },
    codex: { ...EMPTY_AGENT_STATE },
    pi: { ...EMPTY_AGENT_STATE },
  }));
  const [codexSyncBusy, setCodexSyncBusy] = useState(false);

  const updateAgent = useCallback(
    (kind: AgentKind, patch: Partial<AgentRowState>) => {
      setAgents((prev) => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));
    },
    [],
  );

  const probe = useCallback(
    async (kind: AgentKind) => {
      updateAgent(kind, { loading: true });
      try {
        const { probe: result } = await window.electronAPI.remoteSsh.probeAgent(hostId, kind);
        updateAgent(kind, { loading: false, probe: result });
      } catch (err) {
        updateAgent(kind, { loading: false });
        toast.error(
          t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.probeFailed' })),
        );
      }
    },
    [hostId, t, updateAgent],
  );

  // Initial probe for all agents when the detail mounts.
  // 轮 31 发现 3:补 pi —— 此前只 probe claude-code/codex, Pi 行永远显示
  // 「未安装」直到手动刷新。
  useEffect(() => {
    void probe('claude-code');
    void probe('codex');
    void probe('pi');
  }, [probe]);

  // Subscribe to install-progress push events.
  useEffect(() => {
    const off = window.electronAPI.remoteSsh.onInstallProgress((payload) => {
      if (payload.hostId !== hostId) return;
      const kind = payload.agentKind;
      const ev = payload.event;
      setAgents((prev) => {
        const cur = prev[kind];
        const nextLog = [...cur.installLog, formatProgressLine(ev)];
        return { ...prev, [kind]: { ...cur, installLog: nextLog } };
      });
    });
    return () => off();
  }, [hostId]);

  const install = useCallback(
    async (kind: AgentKind) => {
      updateAgent(kind, { installing: true, installLog: [] });
      try {
        const { result } = await window.electronAPI.remoteSsh.installAgent(hostId, kind);
        updateAgent(kind, {
          installing: false,
          probe: {
            agentKind: kind,
            nodeReady: result.nodeVersion != null,
            nodeVersion: result.nodeVersion,
            installed: result.installed,
            installedVersion: result.installedVersion,
            installDir: result.installDir,
            binaryPath: result.binaryPath,
            error: result.error,
          },
        });
        toast.success(t('settings.remote.toast.installed', { name: agentDisplayName(kind, t) }));
      } catch (err) {
        updateAgent(kind, { installing: false });
        toast.error(
          t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.installFailed' })),
        );
      }
    },
    [hostId, t, updateAgent],
  );

  const uninstall = useCallback(
    async (kind: AgentKind) => {
      updateAgent(kind, { loading: true });
      try {
        await window.electronAPI.remoteSsh.uninstallAgent(hostId, kind);
        await probe(kind);
        toast.success(t('settings.remote.toast.uninstalled'));
      } catch (err) {
        updateAgent(kind, { loading: false });
        toast.error(
          t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.uninstallFailed' })),
        );
      }
    },
    [hostId, probe, t, updateAgent],
  );

  const installedKinds = useMemo<AgentKind[]>(
    () => AGENT_KINDS.filter((k) => agents[k].probe?.installed),
    [agents],
  );

  // ── Codex auth sync ────────────────────────────────────────────────────
  // Two-step flow (per security plan):
  //   1. Backend check: do we even have a local auth.json? Does remote already
  //      have one?
  //   2. If remote already has one, confirm overwrite (could clobber an
  //      independent login). ALWAYS warn about "anyone with SSH access can
  //      steal your OpenAI account".
  //   3. Push.
  const syncCodexAuth = useCallback(async () => {
    if (codexSyncBusy) return;
    setCodexSyncBusy(true);
    try {
      const status = await window.electronAPI.remoteSsh.checkCodexAuth(hostId);
      if (!status.localExists) {
        toast.error(t('settings.remote.toast.codexSyncNoLocal'));
        return;
      }

      const description = buildCodexSyncWarning(
        hostId,
        status.remoteExists,
        status.remoteMtime,
        t,
      );
      const ok = await confirm({
        title: t('settings.remote.codexSync.confirmTitle'),
        description,
        confirmText: status.remoteExists
          ? t('settings.remote.codexSync.confirmOverwrite')
          : t('settings.remote.codexSync.confirmPush'),
        cancelText: t('settings.remote.add.cancel'),
        // Don't auto-focus confirm — overwrite is destructive on a logged-in
        // remote, force the user to read and pick.
        autoFocusConfirm: false,
      });
      if (!ok) return;

      const syncResult = await window.electronAPI.remoteSsh.syncCodexAuth(hostId);
      // daemonRestart.ok=false: auth.json 已推送, 但旧 daemon 没杀掉, 还在用
      // in-memory 旧 auth — 显软提示让用户去 reconnect, 不要误导成"完全同步成功"。
      if (!syncResult.daemonRestart.ok) {
        toast.error(t('settings.remote.toast.codexSyncDoneDaemonRestartFailed'));
      } else {
        toast.success(t('settings.remote.toast.codexSyncDone'));
      }
    } catch (err) {
      toast.error(
        t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.codexSyncFailed' })),
      );
    } finally {
      setCodexSyncBusy(false);
    }
  }, [codexSyncBusy, hostId, confirm, t]);

  return (
    <div
      className="flex flex-col gap-4 px-5 py-4"
      style={{ borderTop: '1px solid var(--settings-theme-card-border)' }}
    >
      <div className="flex flex-col gap-3">
        <p
          className="text-13 font-medium"
          style={{ color: 'var(--settings-section-sublabel)' }}
        >
          {t('settings.remote.detail.agentSetupTitle')}
        </p>
        {AGENT_KINDS.map((kind) => (
          <AgentInstallRow
            key={kind}
            kind={kind}
            state={agents[kind]}
            onInstall={() => install(kind)}
            onUninstall={() => uninstall(kind)}
            onProbe={() => probe(kind)}
            // Sync auth: only Codex, only when installed.
            onSyncAuth={
              kind === 'codex' && agents.codex.probe?.installed
                ? syncCodexAuth
                : null
            }
            syncAuthBusy={kind === 'codex' && codexSyncBusy}
          />
        ))}
      </div>

      {installedKinds.length > 0 && (
        <QuickTestPanel hostId={hostId} availableKinds={installedKinds} />
      )}

      <AgentProxyTunnelCard hostId={hostId} />

      {agents.codex.probe?.installed && (
        <StartRemoteSessionPanel hostId={hostId} />
      )}
    </div>
  );
}

// ── agent proxy tunnel status card ──────────────────────────────────────────
//
// 「Agent 流量走本地 Proxy」pref 开启时显示隧道实时状态。快照来自
// remoteSshHostsStore (main 端 status push 驱动, withPrefs 携带 tunnel state)。

function AgentProxyTunnelCard({ hostId }: { hostId: string }) {
  const { t } = useTranslation();
  const snap = useSyncExternalStore(
    (cb) => remoteSshHostsStore.subscribe(cb),
    () => remoteSshHostsStore.get()?.find((h) => h.config.id === hostId) ?? null,
  );
  // 触发一次 ensure, 保证 cold start (没开过 Settings 列表) 也有快照。
  // ensure() 可能因 IPC 失败 reject — 裸 void 会把 rejection 抛成 renderer
  // unhandled rejection; 与 useRemoteSshHosts hook 同款 catch 守护
  // (review: PR #715 copilot R7)。
  useEffect(() => {
    void remoteSshHostsStore.ensure().catch(() => {});
  }, []);

  const pref = snap?.agentProxy ?? null;
  const tunnel = snap?.agentProxyTunnel ?? null;
  // pref 已关但 disable 失败 (daemon 没死透, 错误已落 lastError) 时仍渲染
  // 错误卡片 (codex R17 P2) — 否则 Settings 看起来像成功关闭, 存活 daemon
  // 还握着旧 proxy env, 用户毫无察觉。
  if (!pref && !tunnel?.lastError) return null;
  const localTarget = pref?.mode === 'tunnel' ? `${pref.localHost}:${pref.localPort}` : '';

  let icon;
  let text: string;
  let isError = false;
  if (!pref) {
    // disable 失败分支: pref 已清, 只有 lastError 可显示。
    icon = <AlertCircle size={14} />;
    text = t('settings.remote.detail.agentProxyError', { message: tunnel?.lastError ?? '' });
    isError = true;
  } else if (pref.mode === 'env') {
    // env 模式无隧道 — 只有 apply 成功 (phase='active' 由 main 侧落下) 才
    // 显示「已注入」; 未连接 / 尚未应用 / live-turn 推迟中都显示等待态,
    // 不凭 pref 存在就谎报已生效。
    if (tunnel?.phase === 'error' && tunnel.lastError) {
      icon = <AlertCircle size={14} />;
      text = t('settings.remote.detail.agentProxyError', { message: tunnel.lastError });
      isError = true;
    } else if (snap?.status === 'ready' && tunnel?.phase === 'active') {
      icon = <CheckCircle2 size={14} />;
      text = t('settings.remote.detail.agentProxyEnvInfo', { url: pref.proxyUrl });
    } else {
      icon = <Spinner size={12} />;
      text = t('settings.remote.detail.agentProxyEnvPending', { url: pref.proxyUrl });
    }
  } else if (tunnel?.phase === 'active' && tunnel.remotePort != null) {
    // 隧道走独立 SSH 连接 — 主连接断开期间它可能仍在服务, active 优先展示。
    icon = <CheckCircle2 size={14} />;
    text = t('settings.remote.detail.agentProxyActive', {
      port: tunnel.remotePort,
      target: localTarget,
    });
  } else if (snap?.status !== 'ready' || tunnel?.phase === 'paused') {
    // 主机断连/重连中: 隧道保活挂起, 主连接恢复后自动重建。
    icon = <AlertCircle size={14} />;
    text = t('settings.remote.detail.agentProxyWaiting', { target: localTarget });
  } else if (tunnel?.phase === 'port-busy') {
    icon = <Spinner size={12} />;
    text = t('settings.remote.detail.agentProxyPortBusy', {
      port: tunnel.remotePort ?? pref.remotePort,
    });
  } else if (tunnel?.lastError && tunnel.phase === 'error') {
    icon = <AlertCircle size={14} />;
    text = t('settings.remote.detail.agentProxyError', { message: tunnel.lastError });
    isError = true;
  } else {
    icon = <Spinner size={12} />;
    text = t('settings.remote.detail.agentProxyPending', { target: localTarget });
  }

  return (
    <div className="flex flex-col gap-2">
      <p
        className="text-13 font-medium"
        style={{ color: 'var(--settings-section-sublabel)' }}
      >
        {t('settings.remote.detail.agentProxyTitle')}
      </p>
      <div
        className="flex items-center gap-2 rounded-lg p-3 text-12"
        style={{
          border: '1px solid var(--settings-theme-card-border)',
          color: isError ? 'var(--error-fg)' : 'var(--settings-integration-subtitle)',
        }}
      >
        <Waypoints size={14} className="shrink-0" />
        {icon}
        <span className="break-all">{text}</span>
      </div>
    </div>
  );
}

// ── start-remote-session panel ──────────────────────────────────────────────
//
// Create a real maker session pinned to this remote host. The session goes
// into the sidebar like a normal local session, but when the user sends the
// first message the lazy-create path picks up `remoteHostId` and routes
// CodexAgent through the SSH-bridged transport (codex app-server daemon on
// the remote, ws-over-ssh control channel from us).

interface StartRemoteSessionPanelProps {
  hostId: string;
}

function StartRemoteSessionPanel({ hostId }: StartRemoteSessionPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const [workdir, setWorkdir] = useState<string>('~');
  const [busy, setBusy] = useState(false);

  const handleStart = useCallback(async () => {
    const dir = workdir.trim();
    if (!dir) {
      toast.error(t('settings.remote.startSession.errorWorkdirEmpty'));
      return;
    }
    setBusy(true);
    try {
      // Step 1 (validate): probe the remote workdir BEFORE creating the session.
      //   - 'dir'     → ok, proceed
      //   - 'file'    → reject; can't put a session here
      //   - 'missing' → confirm with user, then mkdir -p
      // resolvedPath has ~ already expanded by remote bash; we use it as the
      // canonical workingDir below so the session metadata never carries an
      // unexpanded tilde (cleaner for codex agent + future browser inspect).
      const stat = await window.electronAPI.remoteSsh.statRemotePath(hostId, dir);
      let resolvedPath = stat.resolvedPath;
      if (stat.kind === 'file') {
        toast.error(t('settings.remote.startSession.errorWorkdirIsFile', { path: resolvedPath }));
        return;
      }
      if (stat.kind === 'missing') {
        const ok = await confirm({
          title: t('settings.remote.startSession.confirmCreateTitle'),
          description: t('settings.remote.startSession.confirmCreateDescription', {
            path: resolvedPath,
            hostId,
          }),
          confirmText: t('settings.remote.startSession.confirmCreateOk'),
          cancelText: t('settings.remote.add.cancel'),
        });
        if (!ok) return;
        const mk = await window.electronAPI.remoteSsh.mkdirPRemote(hostId, dir);
        resolvedPath = mk.resolvedPath;
      }
      // Step 2 (create): DB row pinned to this remote host. Sidebar picks it up
      //                  immediately (sessionsStore subscribes to localDb create events).
      // Step 3 (navigate): the session URL family is /cc-agent/* — historical
      //                    naming, hosts both vendors now. lazy-create maker
      //                    IPC fires on first user prompt, threading
      //                    remoteHostId + workingDir into agent.startSession.
      const session = await sessionService.create({
        agentKind: 'codex',
        workingDir: resolvedPath,
        workspaceKind: 'project',
        permissionMode: 'auto',
        model: 'gpt-5.5-codex',
        remoteHostId: hostId,
      });
      toast.success(t('settings.remote.startSession.created', { hostId }));
      navigate(`/cc-agent/${session.id}`);
    } catch (err) {
      toast.error(
        t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.startSession.createFailed' })),
      );
    } finally {
      setBusy(false);
    }
  }, [hostId, workdir, navigate, t, confirm]);

  return (
    <div
      className="flex flex-col gap-3 rounded-lg p-3"
      style={{ border: '1px solid var(--settings-theme-card-border)' }}
    >
      <div className="flex flex-col gap-0.5">
        <p
          className="text-13 font-medium leading-tight flex items-center gap-1.5"
          style={{ color: 'var(--settings-section-title)' }}
        >
          <Sparkles size={14} />
          {t('settings.remote.startSession.title')}
        </p>
        <p
          className="text-11"
          style={{ color: 'var(--settings-integration-subtitle)' }}
        >
          {t('settings.remote.startSession.hint')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={workdir}
          onChange={(e) => setWorkdir(e.target.value)}
          disabled={busy}
          placeholder="~/projects/my-repo"
          className="flex-1 h-8 rounded-md border bg-transparent px-2 text-12 outline-none"
          style={{
            borderColor: 'var(--settings-theme-card-border)',
            color: 'var(--settings-section-title)',
            fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
          }}
        />
        <button
          type="button"
          onClick={handleStart}
          disabled={busy || !workdir.trim()}
          className={cn(
            'flex h-8 items-center gap-1 rounded-full px-3 text-12 font-medium border',
            (busy || !workdir.trim()) && 'cursor-not-allowed opacity-60',
          )}
          style={{
            backgroundColor: 'var(--settings-btn-secondary-bg)',
            borderColor: 'var(--settings-btn-secondary-border)',
            color: 'var(--settings-btn-secondary-text)',
          }}
        >
          {busy ? <Spinner size={12} /> : <Play size={12} />}
          {t('settings.remote.startSession.start')}
        </button>
      </div>
    </div>
  );
}

// 注意: buildCodexSyncWarning / formatRelativeTime 已抽到 `@/utils/codexAuthSync`,
// 因为 ChatView 的 ErrorBanner 也要走同款 check → confirm → sync 流程, 避免
// "Settings 走 confirm 但 chat banner 直接覆盖" 这种 UX/安全不一致。

// ── agent install row ─────────────────────────────────────────────────────

interface AgentRowProps {
  kind: AgentKind;
  state: AgentRowState;
  onInstall: () => void;
  onUninstall: () => void;
  onProbe: () => void;
  /** Non-null = render "Sync auth" button. Codex-only path B credential push. */
  onSyncAuth: (() => void) | null;
  syncAuthBusy: boolean;
}

function AgentInstallRow({
  kind,
  state,
  onInstall,
  onUninstall,
  onProbe,
  onSyncAuth,
  syncAuthBusy,
}: AgentRowProps) {
  const { t } = useTranslation();
  const { probe, installing, loading, installLog } = state;
  const installed = probe?.installed ?? false;
  const busy = installing || loading;

  let statusIcon;
  let statusText: string;
  if (installing) {
    statusIcon = <Spinner size={14} />;
    statusText = t('settings.remote.detail.statusInstalling');
  } else if (loading) {
    statusIcon = <Spinner size={14} />;
    statusText = t('settings.remote.detail.statusProbing');
  } else if (installed) {
    statusIcon = <CheckCircle2 size={14} />;
    statusText = probe?.installedVersion ?? t('settings.remote.detail.statusInstalled');
  } else if (probe?.error) {
    statusIcon = <AlertCircle size={14} />;
    statusText = probe.error;
  } else {
    statusIcon = null;
    statusText = t('settings.remote.detail.statusNotInstalled');
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{ border: '1px solid var(--settings-theme-card-border)' }}
    >
      <div className="flex items-center gap-3">
        <div className="flex flex-1 flex-col gap-0.5 min-w-0">
          <span
            className="text-13 font-medium leading-tight"
            style={{ color: 'var(--settings-section-title)' }}
          >
            {agentDisplayName(kind, t)}
          </span>
          <div
            className="flex items-center gap-1.5 text-12"
            style={{ color: 'var(--settings-integration-subtitle)' }}
          >
            {statusIcon}
            <span className="truncate">{statusText}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onSyncAuth && (
            <button
              type="button"
              onClick={onSyncAuth}
              disabled={busy || syncAuthBusy}
              title={t('settings.remote.detail.button.syncAuthTip')}
              className={cn(
                'flex h-7 items-center gap-1 rounded-full px-3 text-12 leading-none border',
                (busy || syncAuthBusy) && 'cursor-not-allowed opacity-60',
              )}
              style={{
                backgroundColor: 'transparent',
                borderColor: 'var(--settings-btn-secondary-border)',
                color: 'var(--settings-btn-secondary-text)',
              }}
            >
              {syncAuthBusy ? <Spinner size={12} /> : <Upload size={12} />}
              <span className="relative top-px">{t('settings.remote.detail.button.syncAuth')}</span>
            </button>
          )}
          {installed && (
            <button
              type="button"
              onClick={onUninstall}
              disabled={busy}
              className={cn(
                'flex h-7 items-center rounded-full px-3 text-12 leading-none border',
                busy && 'cursor-not-allowed opacity-60',
              )}
              style={{
                backgroundColor: 'transparent',
                borderColor: 'var(--settings-btn-secondary-border)',
                color: 'var(--settings-btn-secondary-text)',
              }}
            >
              <span className="relative top-px">{t('settings.remote.detail.button.uninstall')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onInstall}
            disabled={busy}
            className={cn(
              'flex h-7 items-center rounded-full px-3 text-12 leading-none font-medium border',
              busy && 'cursor-not-allowed opacity-60',
            )}
            style={{
              backgroundColor: 'var(--settings-btn-secondary-bg)',
              borderColor: 'var(--settings-btn-secondary-border)',
              color: 'var(--settings-btn-secondary-text)',
            }}
          >
            <span className="relative top-px">{installed
              ? t('settings.remote.detail.button.reinstall')
              : t('settings.remote.detail.button.install')}</span>
          </button>
          {!installing && !installed && (
            <button
              type="button"
              onClick={onProbe}
              disabled={busy}
              className="flex h-7 items-center rounded-full px-3 text-12 leading-none border"
              style={{
                backgroundColor: 'transparent',
                borderColor: 'var(--settings-btn-secondary-border)',
                color: 'var(--settings-integration-subtitle)',
              }}
            >
              <span className="relative top-px">{t('settings.remote.detail.button.refresh')}</span>
            </button>
          )}
        </div>
      </div>

      {/* 守卫: installing (用户主动点 Install) || installLog 有内容 (可能来自
          maker:send 触发的 silent install 推过来, 通过同一 INSTALL_PROGRESS push)。
          后者让用户切到 Settings 时如果 silent install 还在跑, 能看到实时 log;
          但已结束的 install 错过窗口看不到 — useEffect 是 mount 时才订阅, 没在线
          时发的 event 不补 (Phase D 的取舍, 不引 main 端 log buffer)。 */}
      {(installing || installLog.length > 0) && (
        <pre
          className="max-h-32 overflow-auto rounded-md border p-2 text-11 leading-tight"
          style={{
            backgroundColor: 'var(--settings-input-bg, #faf9f5)',
            borderColor: 'var(--settings-input-border, #d7d7d4)',
            color: 'var(--settings-input-text, #262626)',
            fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
            margin: 0,
          }}
        >
          {installLog.join('\n')}
        </pre>
      )}
    </div>
  );
}

// ── quick test panel ──────────────────────────────────────────────────────

interface QuickTestPanelProps {
  hostId: string;
  availableKinds: AgentKind[];
}

function QuickTestPanel({ hostId, availableKinds }: QuickTestPanelProps) {
  const { t } = useTranslation();
  const [pickedKind, setPickedKind] = useState<AgentKind>(availableKinds[0]);
  const [prompt, setPrompt] = useState('Say "hello from remote" and nothing else.');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RemoteAgentOneShotResult | null>(null);
  // re-pick if the previously picked kind got uninstalled.
  useEffect(() => {
    if (!availableKinds.includes(pickedKind) && availableKinds.length > 0) {
      setPickedKind(availableKinds[0]);
    }
  }, [availableKinds, pickedKind]);

  const run = useCallback(async () => {
    if (!prompt.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      const { result: r } = await window.electronAPI.remoteSsh.runAgentOneShot(
        hostId,
        pickedKind,
        prompt,
      );
      setResult(r);
    } catch (err) {
      toast.error(
        t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.oneShotFailed' })),
      );
    } finally {
      setRunning(false);
    }
  }, [hostId, pickedKind, prompt, t]);

  return (
    <div className="flex flex-col gap-3">
      <p
        className="text-13 font-medium"
        style={{ color: 'var(--settings-section-sublabel)' }}
      >
        {t('settings.remote.detail.quickTestTitle')}
      </p>

      <div
        className="flex flex-col gap-2 rounded-lg p-3"
        style={{ border: '1px solid var(--settings-theme-card-border)' }}
      >
        <div className="flex items-center gap-2">
          <select
            value={pickedKind}
            onChange={(e) => setPickedKind(e.target.value as AgentKind)}
            disabled={running}
            className="h-8 rounded-lg border bg-transparent px-2 text-13 outline-none"
            style={{
              borderColor: 'var(--settings-theme-card-border)',
              color: 'var(--settings-section-title)',
            }}
          >
            {availableKinds.map((k) => (
              <option key={k} value={k}>{agentDisplayName(k, t)}</option>
            ))}
          </select>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={running}
            placeholder={t('settings.remote.detail.quickTestPromptPlaceholder')}
            className="h-8 flex-1 rounded-lg border bg-transparent px-3 text-13 outline-none"
            style={{
              borderColor: 'var(--settings-theme-card-border)',
              color: 'var(--settings-section-title)',
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !running) void run(); }}
          />
          <button
            type="button"
            onClick={run}
            disabled={running || !prompt.trim()}
            className={cn(
              'flex h-8 items-center gap-1 rounded-full px-3 text-13 leading-none font-medium border',
              (running || !prompt.trim()) && 'cursor-not-allowed opacity-60',
            )}
            style={{
              backgroundColor: 'var(--settings-btn-secondary-bg)',
              borderColor: 'var(--settings-btn-secondary-border)',
              color: 'var(--settings-btn-secondary-text)',
            }}
          >
            {running ? <Spinner size={14} /> : <Play size={14} />}
            <span className="relative top-px">{t('settings.remote.detail.button.run')}</span>
          </button>
        </div>

        {result && <QuickTestResult result={result} />}
      </div>
    </div>
  );
}

function QuickTestResult({ result }: { result: RemoteAgentOneShotResult }) {
  const { t } = useTranslation();
  const isOk = result.exitCode === 0;
  const hasStderr = result.stderr.trim().length > 0;

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex items-center gap-2 text-11"
        style={{ color: 'var(--settings-integration-subtitle)' }}
      >
        {isOk ? (
          <CheckCircle2 size={12} />
        ) : (
          <AlertCircle size={12} />
        )}
        <span>
          {t('settings.remote.detail.quickTestExit', {
            code: result.exitCode ?? 'n/a',
            ms: result.durationMs,
          })}
        </span>
      </div>
      <pre
        className="max-h-64 overflow-auto rounded-md border p-2 text-12 leading-snug whitespace-pre-wrap"
        style={{
          backgroundColor: 'var(--settings-input-bg, #faf9f5)',
          borderColor: 'var(--settings-input-border, #d7d7d4)',
          color: 'var(--settings-input-text, #262626)',
          fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
          margin: 0,
        }}
      >
        {result.stdout || t('settings.remote.detail.quickTestNoOutput')}
      </pre>
      {hasStderr && (
        <details>
          <summary
            className="cursor-pointer text-11"
            style={{ color: 'var(--settings-integration-subtitle)' }}
          >
            {t('settings.remote.detail.quickTestStderr')}
          </summary>
          <pre
            className="mt-1 max-h-32 overflow-auto rounded-md border p-2 text-11 whitespace-pre-wrap"
            style={{
              backgroundColor: 'var(--settings-input-bg, #faf9f5)',
              borderColor: 'var(--settings-input-border, #d7d7d4)',
              color: 'var(--error-fg)',
              fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
              margin: 0,
            }}
          >
            {result.stderr}
          </pre>
        </details>
      )}
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function agentDisplayName(kind: AgentKind, t: (k: string) => string): string {
  // 轮 33 C1:补 pi 分支 —— 此前落入 claudeCodeName 显示为 "Claude Code"。
  if (kind === 'codex') return 'Codex';
  if (kind === 'pi') return t('settings.remote.detail.piName');
  return t('settings.remote.detail.claudeCodeName');
}

function formatProgressLine(ev: RemoteAgentInstallProgress): string {
  switch (ev.kind) {
    case 'probe':              return '[probe] starting…';
    case 'install-dir':        return `[dir]   ${ev.path}`;
    case 'node-cached':        return `[node]  cached ${ev.version} (reusing)`;
    case 'node-install-start': return `[node]  downloading bundled Node v${ev.version}…`;
    case 'node-download':      return `[node]  ${ev.url}`;
    case 'node-extract':       return `[node]  extracting ${ev.basename}`;
    case 'node-install-done':  return `[node]  ready (${ev.version})`;
    case 'already-installed':  return `[skip]  already installed (${ev.version})`;
    case 'install-start':      return `[npm]   installing ${ev.pkg}`;
    case 'install-log':        return `[npm]   ${ev.line}`;
    case 'install-done':       return '[npm]   done';
    case 'ready':              return `[done]  ${ev.version}`;
    case 'error':              return `[ERR]   ${ev.message}`;
  }
}
