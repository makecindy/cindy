import {
  PINNED_PI_VERSION,
  probeRemoteAgent,
  type RemoteHost,
  type RemoteAgentKind,
  type InstallResult,
  type InstallProgressEvent,
} from "@cindy/maker-remote-ssh";
import { throwIpcError } from "@cindy/remote-agent/ipcValidate";
import { isIpcErrorCode } from "@cindy/remote-agent/shared/ipc-errors";
import { redactCredentialText } from "./sshShell.js";
import type { Logger } from "@cindy/maker-core";

/** silent-install push payload — renderer-side 状态机消费这条切 toast 文案。 */
export interface SilentInstallStatusPushPayload {
  hostId: string;
  agentKind: RemoteAgentKind;
  phase: "started" | "progress" | "done" | "failed";
  /** phase=progress 时附 InstallProgressEvent 的 kind, 给 toast 切阶段文案。
   *  轮 32 MEDIUM:'install-upload' 是 PiManagerInstallProgress 的 kind, 不经过
   *  SILENT_INSTALL_STATUS 广播(pi-manager 安装走独立通道) —— 从 union 移除,
   *  与 renderer 侧 vite-env.d.ts 的类型对齐。 */
  eventKind?: InstallProgressEvent["kind"];
  /** phase=failed 时附错误信息, 给 error toast 显示。 */
  message?: string;
}

interface InstallProgressPushPayload {
  hostId: string;
  agentKind: RemoteAgentKind;
  event: InstallProgressEvent;
}
export interface SshAgentInstallerHost {
  getPool(): { get(id: string): RemoteHost | undefined };
  log: Logger;
  installRemoteAgent(
    host: RemoteHost,
    kind: RemoteAgentKind,
    onProgress: (event: InstallProgressEvent) => void,
  ): Promise<InstallResult>;
  broadcastSilentInstallStatus(payload: SilentInstallStatusPushPayload): void;
  broadcastInstallProgress(payload: InstallProgressPushPayload): void;
}
export function createSshAgentInstaller(host: SshAgentInstallerHost) {
  const {
    getPool,
    log,
    installRemoteAgent,
    broadcastSilentInstallStatus,
    broadcastInstallProgress,
  } = host;

  /**
   * 已知"该 host 上某 agent 已经装好"的内存 cache。命中后跳过 probe,避免每条
   * 消息发送前都跑 ~80ms 的 SSH stat。卸载/重装不通过这里走的话会 stale,但
   * 重装路径(InstallRemoteAgentPanel)结束时会刷新 hosts list, 那条路径不依赖
   * 本 cache, 用户不会卡。
   * 版本维度:pi 记录 probe 时的 installedVersion —— pin 变化(客户端升级)后
   * 旧版本不得命中 cache, 必须穿透重新 probe 触发升级(R5 配置审计 H-6)。
   */
  const remoteAgentInstalledCache = new Map<
    string,
    Map<RemoteAgentKind, { installedVersion: string | null }>
  >();

  /** cache 命中判定:pi 额外要求版本与 pin 一致(v 前缀两种写法都认)。 */
  function isAgentCacheHit(
    cached:
      Map<RemoteAgentKind, { installedVersion: string | null }> | undefined,
    agentKind: RemoteAgentKind,
  ): boolean {
    if (!cached || !cached.has(agentKind)) return false;
    if (agentKind !== "pi") return true;
    const v = cached.get(agentKind)?.installedVersion ?? null;
    return (
      v !== null && (v === PINNED_PI_VERSION || v === `v${PINNED_PI_VERSION}`)
    );
  }

  /**
   * Ensure a remote agent binary exists on the host. Called from maker:send 前置,
   * 把"binary not installed"这类问题从 daemon 启动失败的 stack trace 转成 renderer
   * 能正确 toast 的 SSH_AGENT_NOT_INSTALLED IPC error, 引导用户去 Settings 安装。
   *
   * Claude Code 首次检查走完整 probeRemoteAgent,确保 Cindy 管理的远端 runtime
   * 与当前 pin 一致；Codex 同样探测版本及完整包布局，旧 standalone 触发升级。
   * 各引擎命中内存 cache 后续都是 ~0ms。
   */
  async function ensureRemoteAgentInstalled(
    hostId: string,
    agentKind: RemoteAgentKind,
  ): Promise<void> {
    const cached = remoteAgentInstalledCache.get(hostId);
    if (isAgentCacheHit(cached, agentKind)) return;

    const host = getPool().get(hostId);
    if (!host || host.getStatus() !== "ready") {
      // ensureRemoteHostReady 必须先调过 — 这里不主动连, 让上层显式处理 ssh 错误。
      throwIpcError("SSH_NOT_CONNECTED", `ssh host ${hostId} not connected`);
    }

    const probe = await probeRemoteAgent(host, agentKind);
    const ok = probe.installed;
    const installedVersion = probe.installedVersion;
    if (!ok) {
      const friendlyKind =
        agentKind === "codex"
          ? "Codex"
          : agentKind === "pi"
            ? "Pi"
            : "Claude Code";
      throwIpcError(
        "SSH_AGENT_NOT_INSTALLED",
        `远端 ${hostId} 还没安装 ${friendlyKind}。请到 设置 → 远端机器 → 展开 ${hostId} → ${friendlyKind} 那行点"安装"。`,
      );
    }
    const entry = { installedVersion };
    if (!cached)
      remoteAgentInstalledCache.set(hostId, new Map([[agentKind, entry]]));
    else cached.set(agentKind, entry);
  }

  /**
   * 同一 (hostId, agentKind) 正在跑的 silent install Promise. 命中就 await 已有的,
   * 避免并发场景下 (用户连发两条消息 / silent install 跟手动 install 同时撞) 重复
   * 跑 install.sh。Promise resolve/reject 后会 delete, 下次没装会重新跑一次。
   */
  const inFlightInstall = new Map<string, Promise<InstallResult>>();

  function inFlightKey(hostId: string, agentKind: RemoteAgentKind): string {
    return `${hostId}::${agentKind}`;
  }

  /**
   * "确保装好, 没装就装" — 给 maker:send 路径用。已装 (cache / stat) 直接 return,
   * 没装则自动跑一次 installRemoteAgent + 推 SILENT_INSTALL_STATUS 让 renderer
   * toast 给阶段进度反馈; 同时把 InstallProgressEvent 推到 INSTALL_PROGRESS channel,
   * 这样用户正好打开 Settings → 该 host 详情时, RemoteHostDetail 的 log 区会实时
   * 展示逐行 install 输出 (跟手动 install 同源)。
   *
   * 失败抛 SSH_INSTALL_FAILED IpcError, 上层 maker:send 透传给 renderer, toast
   * 状态机收到 phase=failed 后再把 error toast 弹出来。
   *
   * 并发: 同 (hostId, agentKind) 只跑一次 install, 通过 inFlightInstall Map 拦截。
   */
  async function ensureRemoteAgentInstalledOrInstall(
    hostId: string,
    agentKind: RemoteAgentKind,
  ): Promise<InstallResult> {
    // 已装 cache 命中 — 微秒级返回, 不发任何 event
    const cached = remoteAgentInstalledCache.get(hostId);
    if (isAgentCacheHit(cached, agentKind)) {
      return {
        agentKind,
        ready: true,
        nodeReady: true,
        nodeVersion: null,
        installed: true,
        installedVersion: cached?.get(agentKind)?.installedVersion ?? null,
        installDir: "",
        binaryPath: null,
        error: null,
      };
    }

    // 复用 ensureRemoteAgentInstalled 的 stat 检查 (它内部也会写 cache)
    try {
      await ensureRemoteAgentInstalled(hostId, agentKind);
      return {
        agentKind,
        ready: true,
        nodeReady: true,
        nodeVersion: null,
        installed: true,
        installedVersion: null,
        installDir: "",
        binaryPath: null,
        error: null,
      };
    } catch (err) {
      // 只接 SSH_AGENT_NOT_INSTALLED 这条 — 其它 (SSH_NOT_CONNECTED 等) 直接透传抛出
      const code = (err as { code?: string }).code;
      if (code !== "SSH_AGENT_NOT_INSTALLED") throw err;
    }

    // 并发拦截
    // ⚠️ get → set 之间必须保持纯同步块(无 await):Node 事件循环 FIFO 保证并发
    // 调用者中先到的先 set, 后到的 join in-flight promise。若未来在此插入 await
    // (如 host readiness 复核), 竞争窗口会变成真实并发冲突(R7 并发审计 LOW)。
    const key = inFlightKey(hostId, agentKind);
    const existing = inFlightInstall.get(key);
    if (existing) return existing;

    const host = getPool().get(hostId);
    if (!host)
      throwIpcError("SSH_HOST_NOT_FOUND", `unknown ssh host: ${hostId}`);
    if (host.getStatus() !== "ready") {
      throwIpcError("SSH_NOT_CONNECTED", `ssh host ${hostId} not connected`);
    }

    const promise = (async () => {
      log.info("silent-install: starting", { hostId, agentKind });
      broadcastSilentInstallStatus({ hostId, agentKind, phase: "started" });
      // 累积 install-log / error 行尾, 失败时拼到 toast message — 这样用户看 toast
      // 就能直接看到 "curl: (56) ... 403" 这种关键诊断行, 不用打开 Settings 翻 log。
      // 只保留最后 6 条避免 message 太长 (toast 现已支持 whitespace-pre-wrap 多行)。
      const TAIL_LIMIT = 6;
      const logTail: string[] = [];
      let failureNotified = false;
      try {
        const result = await installRemoteAgent(host, agentKind, (progress) => {
          // 维护尾部 log 串 — 只收 install-log 行做诊断补充。error event 不收:
          // installer.ts 已经把 ERROR 行的 message 写到 state.error, 失败时作为
          // result.error 透出来当 baseMsg, 这里再 push 就会跟 baseMsg 重复显示。
          if (progress.kind === "install-log") {
            // 轮 20-V4 HIGH:install-log 行来自远端安装脚本原样输出(stderr/ls/file/
            // head 诊断), 可能含绝对路径/命令片段/文件列表/凭证。所有用户可见出口
            // (toast composedMsg + Settings installLog)统一脱敏后再进 —— 既保诊断
            // 价值(curl 403 这类行), 又不外泄敏感细节。
            const redacted = redactCredentialText(progress.line).slice(0, 500);
            logTail.push(redacted);
            if (logTail.length > TAIL_LIMIT) logTail.shift();
          }
          // (1) 推 INSTALL_PROGRESS — Settings 里 RemoteHostDetail 已订阅, 自动累积
          //     到 installLog, 用户正好打开就能看实时日志。
          broadcastInstallProgress({
            hostId,
            agentKind,
            event:
              progress.kind === "install-log"
                ? {
                    ...progress,
                    line: redactCredentialText(progress.line).slice(0, 500),
                  }
                : progress,
          });
          // (2) 推 SILENT_INSTALL_STATUS — toast 状态机切阶段文案。
          broadcastSilentInstallStatus({
            hostId,
            agentKind,
            phase: "progress",
            eventKind: progress.kind,
          });
        });
        if (!result.ready) {
          const baseMsg = result.error ?? "install did not reach ready state";
          // 拼上最近 install log 尾, 让 renderer toast 直接显示根因 (curl 403 / 网络等)。
          const composedMsg =
            logTail.length > 0 ? `${baseMsg}\n${logTail.join("\n")}` : baseMsg;
          log.warn("silent-install: failed (not ready)", {
            hostId,
            agentKind,
            error: composedMsg,
          });
          broadcastSilentInstallStatus({
            hostId,
            agentKind,
            phase: "failed",
            message: composedMsg,
          });
          failureNotified = true;
          throwIpcError("SSH_INSTALL_FAILED", composedMsg);
        }
        // 装好后标 cache, 后续 ensureRemoteAgentInstalled 短路返回。
        // pi 记录 install 结果的 installedVersion, 供版本一致判定(R5 H-6)。
        const map =
          remoteAgentInstalledCache.get(hostId) ??
          new Map<RemoteAgentKind, { installedVersion: string | null }>();
        map.set(agentKind, { installedVersion: result.installedVersion });
        remoteAgentInstalledCache.set(hostId, map);
        log.info("silent-install: done", { hostId, agentKind });
        broadcastSilentInstallStatus({ hostId, agentKind, phase: "done" });
        return result;
      } catch (err) {
        // 轮 40-w4-t9 MEDIUM:透传的 code 必须是共享 IpcErrorCode 白名单 ——
        // RpcClient 的内部传输码(STREAM_CLOSED/STREAM_DESTROYED)不在表里,
        // renderer 的 extractIpcError 认不出会变成不可路由的通用失败。
        // 轮 18-U4 HIGH:非白名单 code 收口到 INTERNAL 而非 SSH_INSTALL_FAILED ——
        // daemon/RPC 语义码(SESSION_KILL_SURVIVED / SERVER_BUSY /
        // SESSION_LIMIT_EXCEEDED / STREAM_* / TIMEOUT)是「运行时/传输」错误,
        // 不是安装失败;改写成 SSH_INSTALL_FAILED 会误导调用方走安装重试分支。
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code;
        // Every started attempt needs a terminal event, including preflight IPC errors.
        if (!failureNotified) {
          broadcastSilentInstallStatus({
            hostId,
            agentKind,
            phase: "failed",
            message: msg,
          });
        }
        if (!code || !isIpcErrorCode(code)) {
          log.error("silent-install: unexpected error", {
            hostId,
            agentKind,
            error: msg,
          });
          throwIpcError("INTERNAL", msg);
        }
        // Preserve recognized IPC codes after closing the installation status.
        throw err;
      }
    })();

    inFlightInstall.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlightInstall.delete(key);
    }
  }
  return {
    remoteAgentInstalledCache,
    isAgentCacheHit,
    ensureRemoteAgentInstalled,
    inFlightInstall,
    inFlightKey,
    ensureRemoteAgentInstalledOrInstall,
  };
}
