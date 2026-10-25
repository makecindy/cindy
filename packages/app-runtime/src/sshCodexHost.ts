import type {CodexAgent,Logger} from '@cindy/maker-core';
import type {RemoteHost} from '@cindy/maker-remote-ssh';
import {createSshDaemonTransport} from './codex-remote-transport.js';
import type {createAgentProxy} from './agent-proxy.js';
export function createSshCodexHost({getRemoteSshPool,desktopMakerLogger,reconcileCodexAgentProxyEnv}:{getRemoteSshPool():{get(id:string):RemoteHost|undefined};desktopMakerLogger:Logger;reconcileCodexAgentProxyEnv:ReturnType<typeof createAgentProxy>['reconcileCodexAgentProxyEnv']}):Pick<ConstructorParameters<typeof CodexAgent>[0],'getRemoteCodexTransport'>{return {getRemoteCodexTransport: (remoteHostId) => {
        const remoteHost = getRemoteSshPool().get(remoteHostId);
        if (!remoteHost) {
          throw new Error(
            `remote SSH host "${remoteHostId}" not found in pool — connect it first under Settings → Remote`,
          );
        }
        if (remoteHost.getStatus() !== 'ready') {
          throw new Error(
            `remote SSH host "${remoteHostId}" is not connected (status=${remoteHost.getStatus()}) — connect it under Settings → Remote first`,
          );
        }
        return createSshDaemonTransport({
          remoteHost,
          logger: desktopMakerLogger,
          // 「Agent 流量走本地 Proxy」: pref 开启时先建 SSH 反向隧道 + 对账
          // codex daemon 的 env marker (漂移 → 重写 + 重启 daemon), 然后才让
          // transport 探活/拉起 daemon。pref 关闭时 reconcile 是幂等 no-op。
          beforeDaemonProbe: async () => {
            // markerChanged && !daemonRestarted = 旧 daemon 活着跑旧 env —
            // 继续 probe 会 attach 到 stale daemon, UI 报 tunnel active 而
            // codex 流量走旧路由 (codex R10 P1): 按 bootstrap 失败抛出, 让
            // session start 显式报错, 而不是静默复用。
            // deferredForLiveTurn (host 上有别的 turn 在跑) 则放行 attach:
            // 这正是「不 mid-turn 杀 daemon」的代价 — 新 session 暂用旧
            // env, turn-done 挂钩补刀后自愈。
            const reconciled = await reconcileCodexAgentProxyEnv(remoteHost);
            if (reconciled.markerChanged && !reconciled.daemonRestarted) {
              throw new Error(
                'codex daemon survived pkill after agent-proxy env change; refusing to attach the stale daemon (retry or restart the host)',
              );
            }
          },
        });
      }};}
