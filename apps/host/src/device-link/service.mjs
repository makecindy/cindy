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
  DL_USAGE_WIDGET_SNAPSHOT_CHANNEL,
  topicForPush,
} from '@cindy/device-link';
import { compressGzipSync, gunzipBase64TextBounded } from '@cindy/device-link/node-compression';

function extractTopics(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === 'object' && Array.isArray(raw.topics)) {
    return raw.topics.map(String);
  }
  if (typeof raw === 'string') return [raw];
  return [];
}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return os.homedir();
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

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
      } else if (channel === 'local-db:sessions:update' || channel === 'local-db:sessions:patch-meta') {
        result = await deps.updateSession(String(args[0]), args[1] ?? {});
      } else if (channel === 'local-db:sessions:create') {
        result = await deps.createSession(args[0] ?? {});
      } else if (channel === 'local-db:messages:list') {
        const sessionId = typeof args[0] === 'string' ? args[0] : args[0]?.sessionId;
        const opts = typeof args[0] === 'string' ? args[1] : args[0];
        if (deps.messagesList) {
          result = await deps.messagesList(String(sessionId), opts?.limit, opts?.before);
        } else {
          result = await deps.listMessages({ sessionId: String(sessionId), limit: opts?.limit });
        }
      } else if (channel === 'local-db:messages:around-client-id' || channel === 'local-db:messages:around') {
        const sessionId = String(args[0]);
        const identifier = String(args[1]);
        const opts = typeof args[2] === 'object' && args[2] !== null ? args[2] : {};
        result = deps.messagesAroundClientId
          ? await deps.messagesAroundClientId(sessionId, identifier, opts)
          : [];
      } else if (channel === 'local-db:messages:dismiss-error' || channel === 'local-db:sessions:ack-interrupted') {
        result = { ok: true };
      } else if (channel === 'maker:regenerate-title') {
        result = { ok: true };
      } else if (channel === 'maker:create-session') {
        const opts = args[0] ?? {};
        const created = await deps.createSession(opts);
        let capabilities = created.capabilities;
        if (!capabilities && deps.getCapabilities) {
          try { capabilities = await deps.getCapabilities(created.agentKind); } catch {}
        }
        result = {
          sessionId: created.id ?? created.sessionId,
          agentKind: created.agentKind,
          workDir: created.workingDir ?? created.workDir,
          capabilities: capabilities ?? null,
          usedProjectContext: false,
        };
      } else if (channel === 'maker:list-active') {
        const options = args[0];
        const maker = deps.getMaker ? deps.getMaker() : deps.maker;
        const sessions = maker ? maker.listActiveSessions().map((s) => ({
          sessionId: s.id,
          agentKind: s.agentKind,
          workDir: s.workDir,
          capabilities: s.capabilities,
          isTurnRunning: s.isTurnRunning ? s.isTurnRunning() : false,
          activityPhase: 'idle',
          activityAttention: false,
        })) : [];
        if (options && typeof options === 'object' && !Array.isArray(options)
          && options.summary === true && options.snapshotVersion === 2) {
          result = { format: 'active-sessions-v2', sessions };
        } else {
          result = sessions;
        }
      } else if (channel === 'maker:set-model') {
        const [sessionId, model, providerId] = args;
        result = await deps.updateSession(String(sessionId), {
          model: String(model),
          ...(providerId !== undefined ? { providerId } : {}),
        });
      } else if (channel === 'maker:set-effort') {
        const [sessionId, effort] = args;
        result = await deps.updateSession(String(sessionId), { effort: String(effort) });
      } else if (channel === 'maker:set-permission-mode') {
        const [sessionId, permissionMode] = args;
        result = await deps.updateSession(String(sessionId), { permissionMode: String(permissionMode) });
      } else if (channel === 'maker:set-plan-mode') {
        const [sessionId, planModeEnabled] = args;
        result = await deps.updateSession(String(sessionId), { planModeEnabled: Boolean(planModeEnabled) });
      } else if (channel === 'maker:set-fast-mode') {
        const [sessionId, fastMode] = args;
        result = await deps.updateSession(String(sessionId), { fastMode });
      } else if (channel === 'maker:set-thinking-enabled') {
        result = { ok: true };
      } else if (channel === 'maker:set-extra-dirs') {
        result = await deps.updateSession(String(args[0]), { extraDirs: args[1] ?? [] });
      } else if (channel === 'maker:switch-session-agent') {
        const [sessionId, agentKind, model, providerId] = args;
        result = await deps.updateSession(String(sessionId), {
          agentKind: String(agentKind),
          ...(model ? { model: String(model) } : {}),
          ...(providerId !== undefined ? { providerId } : {}),
        });
      } else if (channel === 'maker:close-session') {
        const sessionId = String(args[0]);
        if (deps.inputQueue?.stop) await deps.inputQueue.stop(sessionId);
        result = { ok: true };
      } else if (channel === 'maker:resolve-interaction') {
        const [requestId, decision] = args;
        if (deps.interactions?.resolve) {
          await deps.interactions.resolve(String(requestId), decision);
        }
        result = { ok: true };
      } else if (channel === 'maker:get-context-usage') {
        result = null;
      } else if (channel === 'fs:stat-path') {
        const rawPath = typeof args[0] === 'string' ? args[0] : (args[0]?.path ?? '');
        const target = expandHome(rawPath);
        try {
          const st = await fs.promises.stat(target);
          result = st.isDirectory()
            ? { kind: 'dir', resolvedPath: target }
            : { kind: 'file', resolvedPath: target, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs };
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            result = { kind: 'missing', resolvedPath: target };
          } else {
            throw err;
          }
        }
      } else if (channel === 'fs:list-dir') {
        const rawPath = typeof args[0] === 'string' ? args[0] : (args[0]?.path ?? '');
        const target = expandHome(rawPath);
        const dirents = await fs.promises.readdir(target, { withFileTypes: true, encoding: 'utf8' });
        const entries = [];
        for (const d of dirents) {
          const childPath = path.join(target, d.name);
          if (d.isDirectory()) {
            entries.push({ name: d.name, kind: 'dir', path: childPath });
          } else if (d.isSymbolicLink()) {
            try {
              const st = await fs.promises.stat(childPath);
              if (st.isDirectory()) entries.push({ name: d.name, kind: 'symlink', path: childPath });
            } catch { /* skip dangling */ }
          }
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const parent = path.dirname(target);
        result = { resolvedPath: target, entries, parent: parent === target ? null : parent };
      } else if (channel === 'fs:mkdir-p') {
        const rawPath = typeof args[0] === 'string' ? args[0] : (args[0]?.path ?? '');
        const target = expandHome(rawPath);
        await fs.promises.mkdir(target, { recursive: true });
        result = { resolvedPath: target };
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
      } else if (channel === 'device-link:subscribe' || channel === DL_SUBSCRIBE_CHANNEL || channel === 'device-link:topic-subscribe') {
        const topics = extractTopics(args[0]);
        let set = subscriptions.get(src);
        if (!set) {
          set = new Set();
          subscriptions.set(src, set);
        }
        for (const t of topics) set.add(t);
        result = { subscribed: true };
      } else if (channel === 'device-link:unsubscribe' || channel === DL_UNSUBSCRIBE_CHANNEL || channel === 'device-link:topic-unsubscribe') {
        const topics = extractTopics(args[0]);
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
      } else if (channel === 'sidebar-settings:get-project-aliases') {
        result = deps.listProjectAliases ? await deps.listProjectAliases() : [];
      } else if (channel === 'maker:goal:get-status') {
        result = null;
      } else if (channel.startsWith('maker:goal:')) {
        result = { ok: false, error: 'unsupported' };
      } else if (channel === 'device-link:usage-widget:snapshot:v1' || channel === DL_USAGE_WIDGET_SNAPSHOT_CHANNEL) {
        result = { ok: false, reason: 'unavailable' };
      } else if (channel === 'provider-group:remote') {
        result = { ok: false, error: 'unsupported' };
      } else if (channel === 'maker:side-chat:list:v1' || channel === 'maker:side-chat:v1') {
        result = [];
      } else if (
        channel === 'maker:usage:claude-subscription'
        || channel === 'maker:usage:xai-subscription'
        || channel === 'maker:claude-session-route:get'
        || channel === 'maker:usage:codex-rate-limits'
        || channel === 'maker:usage:codex-rate-limit-reset'
        || channel === 'maker:usage:codex-reset-auto-use'
      ) {
        result = null;
      } else if (channel === 'maker:get-new-maker-defaults') {
        result = { worktreeEnabled: false };
      } else if (
        channel === 'maker:apply-new-maker-draft-pref'
        || channel === 'maker:apply-new-maker-worktree-pref'
        || channel === 'maker:apply-new-maker-worktree-branch-pref'
        || channel === 'maker:set-session-model-pref'
      ) {
        result = { ok: true };
      } else if (channel === 'maker:get-new-maker-worktree-branch-pref') {
        result = null;
      } else if (channel === 'local-db:history:query') {
        result = { ok: true, sessions: [], hasMore: false };
      } else if (channel === 'local-db:conversations:search') {
        result = { results: [] };
      } else if (channel === 'maker:predict-prompt') {
        result = [];
      } else if (channel === 'maker:usage:model-pricing') {
        result = {};
      } else if (channel === 'maker:api-key:present') {
        result = false;
      } else if (
        channel === 'maker:list-agent-commands'
        || channel === 'maker:list-agent-skills'
        || channel === 'maker:scan-at-resources'
      ) {
        result = [];
      } else if (channel === 'worktree:detect-cwd') {
        result = { eligible: false };
      } else if (channel === 'worktree:list-branches') {
        result = [];
      } else if (channel === 'worktree:suggest-name') {
        result = { name: 'worktree' };
      } else if (channel === 'worktree:create') {
        result = { ok: false, error: 'unsupported' };
      } else if (channel === 'worktree:discard-precreated' || channel === 'worktree:cancel-precreated') {
        result = { ok: true };
      } else if (channel === 'text-file:read-preview') {
        result = null;
      } else if (
        channel === 'maker:fork'
        || channel === 'maker:fork-strip-encrypted'
        || channel === 'maker:get-session-tree'
        || channel === 'maker:navigate-session-tree'
        || channel === 'maker:rewind:preview'
        || channel === 'maker:rewind:commit'
      ) {
        result = null;
      } else if (channel === 'maker:message:delete') {
        result = { ok: true };
      } else if (
        channel === 'maker:session:enable-orca'
        || channel === 'maker:session:disable-orca'
        || channel === 'maker:worker:create'
        || channel === 'maker:worker:switch-focus'
        || channel === 'maker:worker:acknowledge-done'
        || channel === 'maker:worker:archive'
      ) {
        result = { ok: false, error: 'unsupported' };
      } else if (
        channel === 'maker:orca:execution-devices'
        || channel === 'maker:collaboration-settings:get'
        || channel === 'local-db:orca-workflows:list-workers-by-lead'
        || channel === 'local-db:orca-workflows:get-by-worker-session'
      ) {
        result = [];
      } else if (
        channel === 'maker:schedule:get'
        || channel === 'maker:schedule:list-templates'
        || channel === 'maker:schedule:create-from-template'
        || channel === 'maker:schedule:create'
        || channel === 'maker:schedule:update'
        || channel === 'maker:schedule:list-runs'
        || channel === 'maker:schedule:run-now'
        || channel === 'maker:schedule:pause'
        || channel === 'maker:schedule:resume'
        || channel === 'maker:schedule:delete'
        || channel === 'maker:schedule:get-inflight-count'
        || channel === 'maker:schedule:mark-run-read'
        || channel === 'maker:schedule:mark-schedule-runs-read'
        || channel === 'maker:schedule:delete-run'
        || channel === 'maker:project-automation:remove-schedule'
      ) {
        result = { ok: false, error: 'unsupported' };
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

    client.onFrame(async (env) => {
      const src = env.src;
      if (!src) return;

      if (env.kind === 'link-open' && env.id) {
        handleLinkOpen(src, env.id, env.payload);
      } else if (env.kind === 'link-close') {
        subscriptions.delete(src);
      } else if (env.kind === 'invoke' && env.id) {
        await handleInvoke(src, env.id, env.payload);
      }
    });

    client.onStatusChange((status) => {
      console.log(`[host:device-link] status -> ${status}`);
    });

    const pushToSubscribers = (channel, payload) => {
      if (!client || client.getStatus() !== 'online' || !payload) return;
      const topic = topicForPush(channel, payload);
      for (const [controllerId, topics] of subscriptions.entries()) {
        const matches = !topic
          || topics.has(topic)
          || topics.has('*');
        if (matches) {
          try {
            client.sendPush(controllerId, channel, payload);
          } catch (_) {}
        }
      }
    };

    if (deps.eventHub?.subscribe) {
      eventUnsubscribe = deps.eventHub.subscribe((evt) => {
        if (!client || client.getStatus() !== 'online' || !evt) return;

        // 1. Agent live event stream: text deltas, tools, status, done
        if (evt.type === 'agent_event' || evt.event) {
          const { sessionId, event, persistId } = evt;
          if (sessionId && event) {
            pushToSubscribers('maker:event', { sessionId, event, persistId });
            if (event.type === 'status') {
              const status = event.data?.status ?? (event.data?.isRunning ? 'running' : 'idle');
              pushToSubscribers('maker:status-changed', { sessionId, status });
            }
          }
        }

        // 2. Input queue projection
        if (evt.type === 'input_projection' && evt.projection) {
          pushToSubscribers('maker:input:projection', evt.projection);
        }

        // 3. Persisted message created
        if (evt.type === 'message_created' && evt.sessionId && evt.message) {
          pushToSubscribers('local-db:messages:created', {
            sessionId: evt.sessionId,
            message: evt.message,
          });
        }

        // 4. Session status / metadata patched
        if (evt.type === 'session_changed' && evt.sessionId) {
          const patch = evt.patch ?? (evt.status ? { status: evt.status } : {});
          pushToSubscribers('local-db:sessions:patched', {
            sessionId: evt.sessionId,
            patch,
          });
        }

        // 5. Interaction requests (approvals / questions)
        if (evt.type === 'interaction_request' && evt.sessionId && evt.request) {
          pushToSubscribers('maker:interaction-request', {
            sessionId: evt.sessionId,
            request: evt.request,
          });
        }

        // 6. Interaction dismissed
        if (evt.type === 'interaction_dismissed' && evt.sessionId && evt.requestId) {
          pushToSubscribers('maker:interaction-dismissed', {
            sessionId: evt.sessionId,
            requestId: evt.requestId,
            reason: evt.reason,
          });
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
