import type { PiAgent, Logger } from "@cindy/maker-core";
import type { RemoteHost } from "@cindy/maker-remote-ssh";
import type { createPiRemoteTransport } from "./pi-remote-transport.js";
import type { createPiManagerClient } from "./pi-manager-client.js";
import { createPiRemoteProviderForwardLease } from "./pi-remote-provider-forward.js";
type AgentDeps = ConstructorParameters<typeof PiAgent>[0];
export type SshPiHostHooks = Pick<
  AgentDeps,
  | "getRemotePiTransport"
  | "getRemotePiFileOps"
  | "getRemoteAgentFileOps"
  | "resolveRemotePiBinaryPath"
  | "remotePiSkipMcpBridge"
  | "getRemotePiAgentProxyEnv"
> & {
  rewriteRemotePiMcpBridgeUrl(
    remoteHostId: string,
    localUrl: string,
  ): Promise<{ url: string; close(): void }>;
};
export interface SshPiHost
  extends
    Pick<
      ReturnType<typeof createPiRemoteTransport>,
      | "resolveRemotePiBinaryPath"
      | "createSshPiDaemonTransport"
      | "createRemotePiFileOps"
    >,
    Pick<ReturnType<typeof createPiManagerClient>, "ensurePiManagerInstalled"> {
  getRemoteSshPool(): { get(id: string): RemoteHost | undefined };
  desktopMakerLogger: Logger;
  broadcastSilentInstallStatus(payload: {
    hostId: string;
    agentKind: "pi";
    phase: "failed" | "done" | "progress";
    message?: string;
    eventKind?: string;
  }): void;
  getRemoteAgentProxyEnv(
    host: RemoteHost,
  ): Promise<Record<string, string> | null>;
}
export function createSshPiHost(host: SshPiHost): SshPiHostHooks {
  const {
    getRemoteSshPool,
    resolveRemotePiBinaryPath,
    createSshPiDaemonTransport,
    createRemotePiFileOps,
    ensurePiManagerInstalled,
    desktopMakerLogger,
    broadcastSilentInstallStatus,
    getRemoteAgentProxyEnv,
  } = host;
  const PI_MCP_FORWARD_PORT_START = 47981;
  return {
    // 远端 Pi:给 session 标 remoteHostId 的, PiAgent 通过这个钩子拿远端
    // transport — SSH 连接复用 ConnectionPool (remote-ssh feature 起的),
    // 这里包一层 RemoteHost + SshPiTransport (execStream 直桥远端 pi --mode rpc)。
    // 远端机器没在 pool / 未连接 → 抛错, PiAgent 把它当 startSession 失败传上去。
    getRemotePiTransport: async (
      remoteHostId,
      {
        binaryPath: _localBinaryPath,
        remoteBinaryPath: providedRemoteBinaryPath,
        args,
        cwd,
        env,
        logger,
        sessionId,
        hostProxyForwards,
      },
    ) => {
      const remoteHost = getRemoteSshPool().get(remoteHostId);
      if (!remoteHost) {
        throw new Error(
          `remote SSH host "${remoteHostId}" not found in pool — connect it first under Settings → Remote`,
        );
      }
      if (remoteHost.getStatus() !== "ready") {
        throw new Error(
          `remote SSH host "${remoteHostId}" is not connected (status=${remoteHost.getStatus()}) — connect it under Settings → Remote first`,
        );
      }
      // 远端必须用远端安装的 pi 二进制(probe 出 $INSTALL_DIR/pi/pi),不能用本地
      // binaryPath —— 那是本机 userData 下的路径,远端不存在(连带 plan-mode 扩展
      // 路径与 subagent 二进制 env 都指向远端才能工作)。
      // 轮 29 MEDIUM:优先用 PiAgent startSession 已 resolve 并传入的
      // remoteBinaryPath(接口契约「host 已 probe」)—— 只在缺失时自己 probe
      // 兜底, 避免两次 resolve 语义分叉(cache 失效窗口)。
      const remoteBinaryPath =
        providedRemoteBinaryPath ??
        (await resolveRemotePiBinaryPath(remoteHost));
      // daemon 持久模式:远端 pi-manager(TS 单例 daemon)持有 pi 进程,ssh 断链后
      // 会话继续跑,重连 attach(对齐 codex app-server daemon / cc-mgr)。
      // 首次 ensure 前确保 pi-manager bundle 装好 + daemon 在跑。
      // daemon session key = maker sessionId(同一会话重连 attach 到同一 daemon 进程)。
      // onEvent(轮 15 缺口 3/6):install 进度转发 silent install toast —— 首次
      // 使用 pi remote 时 1-3s 的 bundle 上传/daemon spawn 不再静默。
      await ensurePiManagerInstalled(
        remoteHost,
        desktopMakerLogger,
        (event) => {
          const hostId = remoteHost.id;
          if (event.kind === "error") {
            broadcastSilentInstallStatus({
              hostId,
              agentKind: "pi",
              phase: "failed",
              message: event.message,
            });
          } else if (event.kind === "ready") {
            broadcastSilentInstallStatus({
              hostId,
              agentKind: "pi",
              phase: "done",
            });
          } else {
            // install-upload 是 pi-manager 专属 kind, SILENT_INSTALL_STATUS 的
            // eventKind union 不含它(轮 32 MEDIUM 类型对齐) —— 归入 install-log
            // (renderer phaseText 对未知 kind 保持上次文案, 映射后走通用阶段)。
            broadcastSilentInstallStatus({
              hostId,
              agentKind: "pi",
              phase: "progress",
              eventKind:
                event.kind === "install-upload" ? "install-log" : event.kind,
            });
          }
        },
      );
      const providerForwardLease = createPiRemoteProviderForwardLease((spec) =>
        remoteHost.ensureRemoteForward(spec),
      );
      try {
        for (const spec of hostProxyForwards ?? []) {
          await providerForwardLease.ensure(spec);
        }
      } catch (error) {
        await Promise.allSettled([providerForwardLease.releaseAll()]);
        throw error;
      }
      let transport;
      try {
        transport = createSshPiDaemonTransport({
          remoteHost,
          binaryPath: remoteBinaryPath,
          args,
          cwd,
          env,
          logger,
          daemonSessionId: sessionId ?? undefined,
        });
      } catch (error) {
        await providerForwardLease.releaseAll();
        throw error;
      }
      transport.ensureHostProxyForward = providerForwardLease.ensure;
      if (transport.killRemoteSession) {
        const killRemoteSession = transport.killRemoteSession.bind(transport);
        transport.killRemoteSession = async () => {
          try {
            await killRemoteSession();
          } finally {
            await providerForwardLease.releaseAll();
          }
        };
      } else {
        const close = transport.close.bind(transport);
        transport.close = async (reason?: string) => {
          try {
            await close(reason);
          } finally {
            await providerForwardLease.releaseAll();
          }
        };
      }
      return transport;
    },

    // 远端 Pi 的 agentHome 文件操作:models.json / extensions / perm / subagent 快照 /
    // resume stat 都落到远端机器(pi 进程在远端读)。经 SSH stdin 管道写文件(cat > 原子
    // 写 + chmod),stat 走 statRemotePath 同款脚本,mkdir 走 mkdir -p —— 与 cc-manager
    // bundle 上传同模式,路径绝对不拼进命令行(防 ps / 日志泄漏)。
    getRemotePiFileOps: (remoteHostId) => {
      const remoteHost = getRemoteSshPool().get(remoteHostId);
      if (!remoteHost) {
        throw new Error(
          `remote SSH host "${remoteHostId}" not found in pool — connect it first under Settings → Remote`,
        );
      }
      return createRemotePiFileOps(remoteHost);
    },

    getRemoteAgentFileOps: (remoteHostId) => {
      const remoteHost = getRemoteSshPool().get(remoteHostId);
      if (!remoteHost) {
        throw new Error(
          `remote SSH host "${remoteHostId}" not found in pool — connect it first under Settings → Remote`,
        );
      }
      return createRemotePiFileOps(remoteHost);
    },

    // 远端 pi 二进制路径:probe(远端 `pi --version`)+ cache。
    resolveRemotePiBinaryPath: async (remoteHostId) => {
      const remoteHost = getRemoteSshPool().get(remoteHostId);
      if (!remoteHost) {
        throw new Error(
          `remote SSH host "${remoteHostId}" not found in pool — connect it first under Settings → Remote`,
        );
      }
      return resolveRemotePiBinaryPath(remoteHost);
    },

    // 远端会话:MCP bridge 经 SSH remote-forward 隧道化,远端 pi 够到本地
    // in-process MCP(cindy_orca / orca_worker_bridge / cindy_memory / ghost)。
    // 改 URL 前缀为 remote-forward 地址,identity/token 不变。
    // collab 全局禁用由 piEnvironment 按 server 名精确剥除 orca 类工具
    // (CC/Codex 同闸门, R5 配置审计 H-7);此处不整体 skip —— 整体 skip 会
    // 连 cindy_memory / ghost / 外部 HTTP MCP 一起误杀。
    remotePiSkipMcpBridge: () => false,

    // 把本地 bridge 的 loopback URL(http://127.0.0.1:<localPort>/mcp/<name>)
    // 改写为远端 remote-forward 地址(http://127.0.0.1:<remotePort>/mcp/<name>)。
    //
    // **不复用 ensureRemoteMcpForward**:它写 remote-mcp-forwards.json 的
    // per-host 单槽位(bridgeLocalPort/remotePort),Pi 与 Codex 各自独立 bridge
    // (不同 localPort),后调用方会关掉前调用方的 forward —— 同 host 上两 agent
    // 的 MCP 隧道互相踩踏(R2 MCP BUG-1)。Pi 用 host.ensureRemoteForward 直接建
    // 独立 forward,远端端口从独立基数(PI_MCP_FORWARD_PORT_START)顺延。
    rewriteRemotePiMcpBridgeUrl: async (remoteHostId, localUrl) => {
      const remoteHost = getRemoteSshPool().get(remoteHostId);
      if (!remoteHost) {
        throw new Error(
          `remote SSH host "${remoteHostId}" not found in pool — connect it first under Settings → Remote`,
        );
      }
      // 用 URL 解析改端口再序列化, 避免字符串 replace 误伤 query 参数
      // (R2 MCP BUG-3) 与 Number('')=0 传非法端口 (R2 MCP BUG-7)。
      const u = new URL(localUrl);
      const localPort = u.port;
      if (
        !localPort ||
        Number.isNaN(Number(localPort)) ||
        Number(localPort) <= 0
      ) {
        throw new Error(`pi bridge URL has no usable port: ${localUrl}`);
      }
      const fwd = await remoteHost.ensureRemoteForward({
        localHost: "127.0.0.1",
        localPort: Number(localPort),
        preferredRemotePort: PI_MCP_FORWARD_PORT_START,
      });
      u.port = String(fwd.remotePort);
      // 轮 24 HIGH-2:close 由 pi-host 在会话 dispose 时调用 —— 防 forward
      // 随会话累积耗尽远端端口(fwd.close 幂等, RemoteHost 内部有 dedup)。
      return { url: u.toString(), close: () => void fwd.close() };
    },

    // 「Agent 流量走本地 Proxy」:远端 pi 的 LLM 流量经 SSH remote-forward 走本地代理
    // (与 CC 远端同机制;pref 关闭时 getRemoteAgentProxyEnv 返回 null → 直连)。
    getRemotePiAgentProxyEnv: async (remoteHostId) => {
      const remoteHost = getRemoteSshPool().get(remoteHostId);
      if (!remoteHost) {
        throw new Error(
          `remote SSH host "${remoteHostId}" not found in pool — connect it first under Settings → Remote`,
        );
      }
      return getRemoteAgentProxyEnv(remoteHost);
    },
  };
}
