/**
 * Device Link host service for cindy-host.
 *
 * Connects the headless cindy-host daemon to the Cindy Device Link Relay server
 * (wss://device-link.cindy.app/api/device-link/ws), registering this machine as online
 * and routing remote invocations to host runtime channels.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import {
  DeviceLinkClient,
  computeAllowlistHash,
  SHARED_TASK_CAPABILITY,
  PROVIDER_SHARE_RELAY_CAPABILITY,
  DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1,
  DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
  DEVICE_LINK_CAPABILITY_GITHUB_READ_V1,
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
} from '@cindy/device-link';
import { compressGzipSync, gunzipBase64TextBounded } from '@cindy/device-link/node-compression';

export function createDeviceLinkService(deps) {
  const subscriptions = new Map(); // controllerDeviceId -> Set<string> of topics
  let client = null;
  let eventUnsubscribe = null;
  let running = false;

  const wsUrl = () => {
    const base = deps.realm === 'cn'
      ? 'wss://device-link.cindy.com.cn'
      : 'wss://device-link.cindy.app';
    return `${base}/api/device-link/ws`;
  };

  const transferCodec = {
    gzipBase64: (text) => {
      const { compressed } = compressGzipSync(Buffer.from(text, 'utf8'), 4, true);
      return compressed.toString('base64');
    },
    gunzipBase64: gunzipBase64TextBounded,
    contentTag: (text) => createHash('sha256').update(text).digest('base64url'),
  };

  const getHello = () => ({
    capabilities: [
      SHARED_TASK_CAPABILITY,
      PROVIDER_SHARE_RELAY_CAPABILITY,
    ],
    deviceName: deps.deviceName || os.hostname(),
    platform: process.platform,
    appVersion: deps.appVersion || '0.1.128',
    remoteControlEnabled: true,
    deviceInfo: {
      model: os.hostname(),
      os: `${os.type()} ${os.release()}`,
    },
    busy: false,
  });

  const handleLinkOpen = (src, requestId, payload) => {
    try {
      client?.sendLinkAccept(src, requestId, {
        appVersion: deps.appVersion || '0.1.128',
        allowlistHash: computeAllowlistHash(),
        capabilities: [
          DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1,
          DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
          DEVICE_LINK_CAPABILITY_GITHUB_READ_V1,
        ],
      });
    } catch (err) {
      console.warn('[host:device-link] sendLinkAccept failed:', err);
    }
  };

  const handleInvoke = async (src, id, payload) => {
    const { channel, args = [] } = payload ?? {};
    try {
      let result;
      if (channel === 'local-db:sessions:list') {
        let body = {};
        if (typeof args[0] === 'object' && args[0] !== null) {
          body = args[0];
        } else {
          const [limit, status, options] = args;
          body = {
            limit: typeof limit === 'number' ? limit : 1000,
            ...(typeof status === 'string' ? { status } : {}),
            ...(typeof options === 'object' && options !== null ? { options } : {}),
          };
        }
        result = await deps.listSessions(body);
      } else if (channel === 'local-db:sessions:get') {
        result = await deps.getSession(String(args[0]));
      } else if (channel === 'local-db:sessions:update') {
        result = await deps.updateSession(String(args[0]), args[1] ?? {});
      } else if (channel === 'local-db:sessions:create') {
        result = await deps.createSession(args[0] ?? {});
      } else if (channel === 'local-db:messages:list') {
        const sessionId = typeof args[0] === 'string' ? args[0] : args[0]?.sessionId;
        const opts = typeof args[0] === 'string' ? args[1] : args[0];
        result = await deps.listMessages({ sessionId: String(sessionId), limit: opts?.limit });
      } else if (channel === 'local-db:messages:view' || channel === 'local-db:messages:view-intent') {
        const sessionId = String(args[0]);
        const before = args[1]?.before ?? null;
        result = await deps.historyView(sessionId, before);
      } else if (channel === 'local-db:messages:work-details') {
        result = deps.workDetails
          ? await deps.workDetails(String(args[0]), args[1], args[2] ?? null)
          : null;
      } else if (channel === 'local-db:messages:estimatedSessionValue') {
        result = deps.estimatedSessionValue
          ? await deps.estimatedSessionValue(String(args[0]))
          : 0;
      } else if (channel === 'maker:provider:list') {
        result = await deps.listProviders();
      } else if (channel === 'maker:list-available-agents') {
        result = await deps.listAvailableAgents();
      } else if (channel === 'maker:get-capabilities') {
        result = await deps.getCapabilities(String(args[0] ?? 'claude-code'));
      } else if (channel === 'maker:send') {
        const [sessionId, message, createOpts] = args;
        const text = typeof message === 'string' ? message : message?.content ?? '';
        result = await deps.inputQueue.enqueue(String(sessionId), {
          clientId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          text: typeof text === 'string' ? text : JSON.stringify(text ?? ''),
          persistedContent: typeof text === 'string' ? text : JSON.stringify(text ?? ''),
          model: createOpts?.model ?? '',
          effort: createOpts?.effort ?? '',
          permissionMode: createOpts?.permissionMode ?? '',
          workingDir: createOpts?.workingDir ?? '',
        });
      } else if (channel === 'maker:input:enqueue') {
        result = await deps.inputQueue.enqueue(String(args[0]), args[1]);
      } else if (channel === 'maker:input:stop') {
        result = await deps.inputQueue.stop(String(args[0]));
      } else if (channel === 'maker:input:steer') {
        result = await deps.inputQueue.steer(String(args[0]), String(args[1] ?? ''));
      } else if (channel === 'maker:input:resume') {
        result = await deps.inputQueue.resume(String(args[0]));
      } else if (channel === 'maker:input:remove') {
        result = await deps.inputQueue.remove(String(args[0]), String(args[1] ?? ''));
      } else if (channel === 'maker:input:update-content') {
        result = await deps.inputQueue.updateContent(String(args[0]), String(args[1]), args[2]);
      } else if (channel === 'maker:input:update-text') {
        result = await deps.inputQueue.updateText(String(args[0]), String(args[1]), args[2]);
      } else if (channel === 'maker:input:move') {
        result = await deps.inputQueue.move(String(args[0]), String(args[1]), Number(args[2]));
      } else if (channel === 'maker:input:set-expanded') {
        result = await deps.inputQueue.setExpanded(String(args[0]), Boolean(args[1]));
      } else if (channel === 'maker:input:set-interaction-lock') {
        result = await deps.inputQueue.setInteractionLock(String(args[0]), String(args[1]), Boolean(args[2]));
      } else if (channel === 'maker:input:set-edit-lock') {
        result = await deps.inputQueue.setEditLock(String(args[0]), String(args[1]), Boolean(args[2]));
      } else if (channel === 'maker:input:clear-session') {
        result = await deps.inputQueue.clearSession(String(args[0]));
      } else if (channel === 'maker:input:retry-last-error' || channel === 'maker:input:clear-error' || channel === 'maker:input:cancel-usage-limit-wait') {
        result = deps.inputQueue.projection(String(args[0]));
      } else if (channel === 'maker:input:get-projection') {
        result = deps.inputQueue.getProjection
          ? await deps.inputQueue.getProjection(String(args[0]))
          : deps.inputQueue.projection(String(args[0]));
      } else if (channel === 'maker:plugins:get-state') {
        result = { enabled: false, effectiveEnabled: false, overridden: false };
      } else if (channel === 'git-context:pr-refs:list') {
        result = [];
      } else if (channel === 'local-db:project-aliases:list') {
        result = await deps.listProjectAliases();
      } else if (channel === 'local-db:recent-workdirs:list') {
        result = await deps.listRecentWorkdirs();
      } else if (channel === 'device-link:subscribe' || channel === DL_SUBSCRIBE_CHANNEL) {
        const req = args[0] ?? {};
        const topics = req.topics ?? [];
        let set = subscriptions.get(src);
        if (!set) {
          set = new Set();
          subscriptions.set(src, set);
        }
        for (const t of topics) set.add(t);
        result = { subscribed: true };
      } else if (channel === 'device-link:unsubscribe' || channel === DL_UNSUBSCRIBE_CHANNEL) {
        const req = args[0] ?? {};
        const topics = req.topics ?? [];
        const set = subscriptions.get(src);
        if (set) {
          for (const t of topics) set.delete(t);
        }
        result = { unsubscribed: true };
      } else if (channel === 'maker:get-pending-interactions') {
        result = deps.interactions?.getPending
          ? await deps.interactions.getPending(String(args[0]))
          : [];
      } else if (channel === 'maker:session-background-activity') {
        result = null;
      } else if (channel === 'maker:session-background-tasks:list') {
        result = [];
      } else if (channel === 'maker:session-in-turn') {
        result = false;
      } else if (channel === 'maker:get-session-agent-switch-intent') {
        result = null;
      } else if (channel === 'maker:git-safety:get') {
        result = { safe: true };
      } else if (channel === 'maker:schedule:list-sidebar-index-runs' || channel === 'maker:schedule:list') {
        result = [];
      } else if (channel === 'maker:task-copy') {
        result = { ok: false, error: 'unsupported' };
      } else if (channel === 'notification:clear-session-attention') {
        result = { ok: true };
      } else if (channel === 'git-context:get-for-session') {
        result = null;
      } else if (channel === 'git-review:remote-op') {
        result = { ok: false, error: 'unsupported' };
      } else if (channel === 'ghosts:composer-list') {
        result = [];
      } else if (channel === 'file-browser:remote-op') {
        const opArgs = args[0] ?? {};
        const op = opArgs.op;
        if (op === 'caps') {
          result = { fileRead: true, fileWrite: true, gzip: true };
        } else if (op === 'listDir') {
          const workdir = opArgs.workdir || os.homedir();
          const relPath = opArgs.relPath || '';
          const targetDir = path.resolve(workdir, relPath);
          try {
            const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
            result = entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? 'dir' : 'file',
              size: 0,
              mtimeMs: Date.now(),
            }));
          } catch {
            result = [];
          }
        } else if (op === 'stat') {
          const workdir = opArgs.workdir || os.homedir();
          const relPath = opArgs.relPath || '';
          const target = path.resolve(workdir, relPath);
          try {
            const st = await fs.promises.stat(target);
            result = {
              name: path.basename(target),
              type: st.isDirectory() ? 'dir' : 'file',
              size: st.size,
              mtimeMs: st.mtimeMs,
            };
          } catch {
            result = { type: 'unknown', size: 0, mtimeMs: 0 };
          }
        } else if (op === 'readFile') {
          const workdir = opArgs.workdir || os.homedir();
          const relPath = opArgs.relPath || '';
          const target = path.resolve(workdir, relPath);
          try {
            const content = await fs.promises.readFile(target, 'utf8');
            result = { ok: true, content, size: Buffer.byteLength(content) };
          } catch (err) {
            result = { ok: false, code: 'READ_FAILED', message: String(err) };
          }
        } else {
          result = { ok: false, code: 'UNSUPPORTED' };
        }
      } else if (channel === 'device-link:remote-desktop:v1') {
        result = { supported: false, permissions: { screen: false } };
      } else if (channel === 'local-db:subagent-runs:list') {
        result = [];
      } else if (channel === 'maker:remote-resources:manifest') {
        result = { collections: [] };
      } else if (channel === 'sidebar-settings:get-project-order') {
        result = { manualProjectOrder: [], projectOrder: 'alphabetical' };
      } else if (channel === 'maker:remote-resources:list') {
        result = { items: [], revision: 1 };
      } else if (channel === 'maker:turn-change-sets:list') {
        result = [];
      } else if (channel === 'ghosts:list') {
        result = { ghosts: [] };
      } else if (channel === 'plugin-market:list-installed') {
        result = [];
      } else if (channel === 'maker:agent-island:get-visibility') {
        result = { visible: false };
      } else {
        console.warn(`[host:device-link] channel not allowed/supported: ${channel}`);
        try {
          client?.sendInvokeResult(src, id, {
            ok: false,
            error: { code: 'CHANNEL_NOT_ALLOWED', message: `channel '${channel}' not allowed remotely` },
          });
        } catch { /* ignore disconnect */ }
        return;
      }

      try {
        client?.sendInvokeResult(src, id, { ok: true, result });
      } catch { /* ignore disconnect */ }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[host:device-link] invoke failed on ${channel}:`, message);
      try {
        client?.sendInvokeResult(src, id, {
          ok: false,
          error: { code: 'IPC_ERROR', message },
        });
      } catch { /* ignore disconnect */ }
    }
  };

  const start = () => {
    if (running) return;
    running = true;

    client = new DeviceLinkClient({
      getWsUrl: wsUrl,
      getToken: deps.getAccessToken,
      getHello,
      transferCodec,
      createWebSocket: (url, headers) => new WebSocket(url, { headers }),
      logger: {
        debug: () => {},
        info: (msg, meta) => console.log('[host:device-link:info]', msg, meta ?? ''),
        warn: (msg, meta) => console.warn('[host:device-link:warn]', msg, meta ?? ''),
        error: (msg, meta) => console.error('[host:device-link:error]', msg, meta ?? ''),
      },
    });

    client.onFrame((env) => {
      const src = env.src;
      if (!src) return;

      if (env.kind === 'link-open' && env.id) {
        handleLinkOpen(src, env.id, env.payload);
      } else if (env.kind === 'link-close') {
        subscriptions.delete(src);
      } else if (env.kind === 'invoke' && env.id) {
        void handleInvoke(src, env.id, env.payload);
      }
    });

    client.onStatusChange((status) => {
      console.log(`[host:device-link] status -> ${status}`);
    });

    if (deps.eventHub?.subscribe) {
      eventUnsubscribe = deps.eventHub.subscribe((evt) => {
        if (!client || client.getStatus() !== 'online') return;

        if (evt.type === 'agent_event') {
          const { sessionId, event } = evt;
          for (const [controllerId, topics] of subscriptions.entries()) {
            if (topics.has(`session:${sessionId}`) || topics.has('sessions') || topics.has('*')) {
              try {
                client.sendPush(controllerId, 'maker:event', { sessionId, event });
              } catch (_) {}
            }
          }
        } else if (evt.type === 'session_created' || evt.type === 'session_updated') {
          for (const [controllerId, topics] of subscriptions.entries()) {
            if (topics.has('sessions') || topics.has('*')) {
              try {
                client.sendPush(controllerId, 'sessions:patched', evt);
              } catch (_) {}
            }
          }
        }
      });
    }

    client.start();
  };

  const stop = () => {
    if (!running) return;
    running = false;
    if (eventUnsubscribe) {
      eventUnsubscribe();
      eventUnsubscribe = null;
    }
    subscriptions.clear();
    if (client) {
      client.stop();
      client = null;
    }
  };

  return {
    start,
    stop,
    getClient: () => client,
  };
}
