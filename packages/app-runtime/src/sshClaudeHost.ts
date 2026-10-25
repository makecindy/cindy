import type {ClaudeCodeAgent,Logger} from '@cindy/maker-core';
import type {RemoteHost} from '@cindy/maker-remote-ssh';
import type {createCcRemoteMcp,CcRemoteHttpMcpDeps} from './ccRemoteMcp.js';
import type {createCcManagerClient} from './ccManagerClient.js';
import type {createCcManagerInstall} from './cc-manager-install.js';
import {routeInjectedRemoteMcpApprovalsThroughCindy} from './remote-claude-permission-mode.js';
type AgentDeps=ConstructorParameters<typeof ClaudeCodeAgent>[0];
type RemoteCcQuery=Awaited<ReturnType<NonNullable<AgentDeps['remoteCcQueryFactory']>>>;
export interface SshClaudeHost extends Pick<ReturnType<typeof createCcRemoteMcp>,'prepareCcRemoteQueryMcp'|'readCcAppliedFingerprint'|'writeCcAppliedFingerprint'|'CC_MCP_DISABLED_FINGERPRINT'>,Pick<ReturnType<typeof createCcManagerClient>,'openCcManagerSession'>,Pick<ReturnType<typeof createCcManagerInstall>,'getRemoteClaudeBinaryPath'>{
getRemoteSshPool():{get(id:string):RemoteHost|undefined};desktopMakerLogger:Logger;
getRemoteAgentProxyEnv(host:RemoteHost):Promise<Record<string,string>|null>;
ensureCodexMcpBridgeStartedForRemote:CcRemoteHttpMcpDeps['ensureBridgeStarted'];
ensureRemoteMcpForward:CcRemoteHttpMcpDeps['ensureForward'];
pluginRegistry:{isEnabled(id:string):boolean};
forcedFreshCcBridgeSessions:Set<string>;staleInvalidatedCcSessions:Set<string>;
}
export function createSshClaudeHost(host:SshClaudeHost):Pick<AgentDeps,'remoteCcQueryFactory'>{const {getRemoteSshPool,desktopMakerLogger,getRemoteAgentProxyEnv,getRemoteClaudeBinaryPath,prepareCcRemoteQueryMcp,ensureCodexMcpBridgeStartedForRemote,ensureRemoteMcpForward,pluginRegistry,readCcAppliedFingerprint,writeCcAppliedFingerprint,CC_MCP_DISABLED_FINGERPRINT,forcedFreshCcBridgeSessions,staleInvalidatedCcSessions,openCcManagerSession}=host;return {remoteCcQueryFactory: async ({
        remoteHostId,
        sessionId,
        sessionInstanceId,
        startParams,
        vendorOptions,
        onApprovalRequest,
        onSubagentModelAccessRequest,
        onOAuthRefresh,
        makerMemoryEnabled,
        makerMemoryScopeKey,
        botSession,
      }) => {
        const host = getRemoteSshPool().get(remoteHostId);
        if (host?.getStatus() !== 'ready') {
          throw new Error(`remote ssh host not ready: ${remoteHostId}`);
        }
        // 「Agent 流量走本地 Proxy」: pref 开启时确保 SSH 反向隧道就绪, 把代理
        // env 合入 startParams.env — cc-mgr daemon 按 session spawn SDK, 每次
        // 会话都吃到当前配置, 无需像 codex daemon 那样重启。隧道 arm 失败
        // (sshd 拒 remote forwarding 等) 直接抛错, 不静默回落直连。
        const proxyEnv = await getRemoteAgentProxyEnv(host);
        // SDK can't self-locate its native CLI binary on remote (bundled-into-cc-mgr
        // optional-dep resolver is frozen to desktop build platform). Probe + cache
        // the path here and pass it down; cc-manager-client merges it into the SDK
        // options via `pathToClaudeCodeExecutable`. First call ~200ms, cache hit instant.
        const claudeBinaryPath = await getRemoteClaudeBinaryPath(host);

        // 远端 cc 的协同 MCP 恢复通道:bridge + remote-forward + per-session
        // token,把 cindy_orca / orca_worker_bridge 以 http 形态追加进
        // startParams.mcpServers (cc remote 过滤器本来就放行 http transport)。
        // 普通任务保留可选 MCP 降级;伙伴缺少 helper 时必须在 query 建立前失败。
        const injected = await prepareCcRemoteQueryMcp(
          {
            host,
            sessionId,
            sessionInstanceId,
            workingDir: typeof startParams.cwd === 'string' ? startParams.cwd : '',
            vendorOptions,
            // per-session Maker Memory 开关 (maker-core 归一后透传)。
            makerMemoryEnabled,
            botSession,
            // 同源的 scope key: Bot 会话恒为 `bot:<botId>`, 缺失时远端工具
            // 会回落 workdir 键, 与本地 prompt 注入的伙伴记忆分家。
            ...(makerMemoryScopeKey ? { makerMemoryScopeKey } : {}),
          },
          {
            ensureBridgeStarted: ensureCodexMcpBridgeStartedForRemote,
            ensureForward: ensureRemoteMcpForward,
            // collab 全局禁用 (Tier 4) 时整个不注入 — bridge 名单不反映
            // 开关 (codex-connector R20 P2, 与 codex daemon 侧同闸门)。
            isCollabEnabled: () => pluginRegistry.isEnabled('collab'),
            onOptionalInjectionError: (err) => {
              desktopMakerLogger.warn('cc remote MCP injection skipped', {
                remoteHostId,
                sessionId,
                message: err instanceof Error ? err.message : String(err),
              });
            },
          },
        );
        const mcpCleanup = injected.cleanup;
        const mcpNeedsFreshStart = injected.needsFreshStart === true;
        const mcpInjectFingerprint = injected.fingerprint;
        const injectedServerCount = Object.keys(injected.servers).length;
        if (injectedServerCount > 0) {
          const mutableParams = startParams as { mcpServers?: Record<string, unknown> };
          mutableParams.mcpServers = { ...(mutableParams.mcpServers ?? {}), ...injected.servers };
        }

        // maker-core computes the initial permission mode before this factory
        // injects collaboration MCP servers. Native OAuth Auto bypasses the
        // approval RPC entirely, so finalize the mode after injection but
        // before openCcManagerSession consumes startParams.
        routeInjectedRemoteMcpApprovalsThroughCindy(startParams, injectedServerCount);

        // app 重启后首轮 bridge MCP 注入:daemon 侧旧 query 若还 alive, 其
        // SDK 持有的 mcp-session-id 在新 bridge 已不存在, attach 会让协同
        // MCP 每次调用 404 且 SDK 不自动重新 initialize。本进程首次注入该
        // session 时强制 fresh start (startParams 带 resumeSdkSessionId,
        // 上下文经远端 cc CLI session 文件恢复)。SSH 断线重连 (app 未重启,
        // bridge 内存表还在) 不触发 — 本 Set 随进程生命周期。
        // 状态只在 open 成功后提交:open 失败 (daemon 未起等) 时下次重试
        // 仍要 forceFresh, 否则 attach 到旧 query 上协同 MCP 永久 404。
        // token 失效 (mcpNeedsFreshStart) 同样强制 fresh:attach 回带旧
        // token header 的 alive query 会持续 401 (codex-connector R21 P2)。
        // 被 invalidate 过 (staleInvalidatedCcSessions) 也一样:collab 禁用
        // 等场景重建时无 server 可注, 不 forceFresh 会 attach 回带旧 collab
        // URL 的 query (codex-connector R22 P2)。
        // 持久代际指纹 drift (codex-connector R23 P2):collab 开→关 /
        // token 轮换 / bridge 代际 / 端口重绑后跨 app 重启, 进程内集合
        // 清空也能判出存活 query 的 MCP 配置属旧代际。
        const ccAppliedFingerprint = readCcAppliedFingerprint(sessionId);
        const ccGenerationDrift =
          mcpInjectFingerprint !== undefined &&
          ccAppliedFingerprint !== null &&
          mcpInjectFingerprint !== ccAppliedFingerprint;
        // 注入失败 / bridge 不可用时没有 desired 指纹,但旧 alive query 可能
        // 仍带着上一代 MCP 配置 (老版本/首次注入尚无 applied 记录时也成立),
        // attach 会复用失效 Authorization / URL / mcp-session-id。此时
        // forceFresh 成无 MCP 的干净 query,并在 open 成功后把 applied 收敛
        // 为 disabled,避免故障期间每次 open 都重复 kill + fresh
        // (Greptile R29 P1)。
        const ccMissingDesiredStale =
          mcpInjectFingerprint === undefined &&
          ccAppliedFingerprint !== CC_MCP_DISABLED_FINGERPRINT;
        // 持久代际 drift (ccGenerationDrift) 不受 fresh 集合豁免:
        // token/bridge/端口变化后 applied 指纹 ≠ desired 时, 已 fresh 过的
        // session 也必须重新 forceFresh — 否则豁免让 drift 判定只在「从未
        // fresh 过」时生效, attach 回持旧 Authorization/URL 的 query
        // (codex-connector R27 P1)。fresh 集合只豁免「同代际的重复注入」。
        const forceFreshQuery =
          ((injectedServerCount > 0 ||
            mcpNeedsFreshStart ||
            staleInvalidatedCcSessions.has(sessionId)) &&
            !forcedFreshCcBridgeSessions.has(sessionId)) ||
          ccGenerationDrift ||
          ccMissingDesiredStale;

        // 协同 MCP 已 mutate 进 startParams.mcpServers;这里再把 proxy env 合入
        // 得到最终 startParams (mcpServers 与 env 都带上)。
        const startParamsWithProxy = proxyEnv
          ? {
              ...(startParams as Record<string, unknown>),
              env: {
                ...((startParams as { env?: Record<string, string> }).env ?? {}),
                ...proxyEnv,
              },
            }
          : startParams;

        const { remoteQuery, dispose, detach } = await (async () => {
          try {
            return await openCcManagerSession({
              host,
              sessionId,
              startParams: startParamsWithProxy as unknown as Parameters<
                typeof openCcManagerSession
              >[0]['startParams'],
              claudeBinaryPath,
              onApprovalRequest: onApprovalRequest as Parameters<
                typeof openCcManagerSession
              >[0]['onApprovalRequest'],
              onSubagentModelAccessRequest: onSubagentModelAccessRequest as Parameters<
                typeof openCcManagerSession
              >[0]['onSubagentModelAccessRequest'],
              onOAuthRefresh: onOAuthRefresh as Parameters<
                typeof openCcManagerSession
              >[0]['onOAuthRefresh'],
              forceFreshQuery,
            });
          } catch (err) {
            // openCcManagerSession 失败时上面注册的 per-session ctx / forward
            // intent 必须清掉,否则残留到同 session 下一次重建或应用退出。
            try {
              mcpCleanup();
            } catch {
              /* cleanup 失败不掩盖原始错误 */
            }
            throw err;
          }
        })();
        if (forceFreshQuery) {
          forcedFreshCcBridgeSessions.add(sessionId);
          staleInvalidatedCcSessions.delete(sessionId);
        }
        // 注入/禁用代际随 open 成功落盘 (attach 也算 — 它确认了该 query
        // 的 MCP 代际);下次 open 前据此判 drift。
        const appliedFingerprintToWrite =
          mcpInjectFingerprint ?? (ccMissingDesiredStale ? CC_MCP_DISABLED_FINGERPRINT : undefined);
        if (appliedFingerprintToWrite) {
          writeCcAppliedFingerprint(sessionId, appliedFingerprintToWrite);
        }

        // 把 ssh transport disposer 串进 remoteQuery.close — maker-core 不知道
        // ssh / RpcClient / nc 这层 transport, 只会调它认得的 Query.close()。
        // openCcManagerSession 的 dispose 已经内部先 await remoteQuery.close()
        // (查询 close RPC + unsubscribe + end queue), 再 client.dispose() 关
        // RpcClient, 再 handle.kill() 关 ssh exec。所以 close 直接重定向到
        // dispose 即可, 不需要分两步。漏接这个 hook 会让 ClaudeCodeAgent close
        // 时 ssh exec 一直挂着, 远端 nc 子进程也不退, 文件描述符泄漏。
        // close 同时注销 per-session MCP token (detach 不清:detach 是断传输
        // 保 session, 重连时 factory 会重新注册)。
        const disposeWithMcpCleanup = async (): Promise<void> => {
          try {
            mcpCleanup();
          } catch (err) {
            desktopMakerLogger.warn('cc remote MCP token cleanup failed', {
              sessionId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          await dispose();
        };
        const remoteQueryWithDispose = Object.assign(remoteQuery, {
          close: disposeWithMcpCleanup,
          detach,
        });
        return remoteQueryWithDispose as unknown as RemoteCcQuery;
      }};}
