/**
 * Wire SessionRegistry methods into ManagerServer RPC handlers.
 *
 * Each query/* and session/* method on the wire maps 1:1 to a SessionRegistry
 * call. Errors thrown by the registry surface as RPC errors with .code field
 * (SESSION_NOT_FOUND / SESSION_ALREADY_EXISTS / SESSION_KILL_PENDING / SESSION_KILL_TIMEOUT / SDK_ERROR / INVALID_PARAMS).
 *
 * The attach lifecycle is handled here too — when a client attaches we install
 * a notify callback on the session that translates events into RpcNotification
 * messages and pushes them through the client's socket. On client disconnect
 * (socket close) we detach the callback from any session it had attached to.
 */


import {
  METHODS,
  NOTIFICATIONS,
  type ClientReplacedNotification,
  type QueryApplyFlagSettingsParams,
  type QueryCloseParams,
  type QueryEventNotification,
  type QueryGetContextUsageParams,
  type QueryInterruptParams,
  type QueryStopTaskParams,
  type QuerySendParams,
  type QuerySetModelParams,
  type QuerySetPermissionModeParams,
  type QueryStartParams,
  type QueryStartResult,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionClosedNotification,
  type SessionKillParams,
  type SessionListResult,
} from './protocol.js';
import { ManagerServer, type MethodHandler } from './server.js';
import {
  SessionRegistry,
  type AttachedNotify,
} from './session-registry.js';
import { encodeMessage } from './codec.js';


/**
 * Per-connection client context — tracks which sessions a given socket has
 * subscribed to so we can detach on close. We piggyback on net.Socket via a
 * Map keyed by socket identity (ManagerServer doesn't expose ctx publicly,
 * so we maintain our own).
 */
interface ClientSubscriptions {
  /** sessionId → notify callback we registered for this client. */
  bySession: Map<string, AttachedNotify>;
}

import type { ClientCtx } from './server.js';

/**
 * Install handlers + return utilities for cross-layer wiring.
 * Idempotent within a server instance — calling twice is supported (just overrides handlers).
 */
export function wireSdkHandlers(server: ManagerServer, registry: SessionRegistry): {
  getAttachedClientCtx: (sessionId: string) => ClientCtx | undefined;
  onClientDisconnected: (ctx: ClientCtx) => void;
} {
  // Track per-socket subscriptions. We use the server context's `socket` as the
  // map key (referenced via the ctx the handler receives).
  const subscriptionsByCtx = new WeakMap<object, ClientSubscriptions>();
  // Track which ClientCtx is currently attached to each session (for reverse-request routing).
  const attachedCtxBySession = new Map<string, ClientCtx>();

  function getSubs(ctx: object): ClientSubscriptions {
    let subs = subscriptionsByCtx.get(ctx);
    if (!subs) {
      subs = { bySession: new Map() };
      subscriptionsByCtx.set(ctx, subs);
    }
    return subs;
  }

  /**
   * Build a notify callback bound to a specific ctx (so we can write
   * notifications back to the right socket). Stored on the session via
   * registry.attach so the consume loop can call it on each SDK event.
   */
  function makeNotify(ctx: { socket: { write(s: string): boolean; destroyed: boolean } }): AttachedNotify {
    return (kind: 'event' | 'closed' | 'replaced', payload: unknown): void => {
      if (ctx.socket.destroyed) return;
      const method =
        kind === 'event'
          ? NOTIFICATIONS.QUERY_EVENT
          : kind === 'closed'
            ? NOTIFICATIONS.SESSION_CLOSED
            : NOTIFICATIONS.CLIENT_REPLACED;
      try {
        ctx.socket.write(
          encodeMessage({
            type: 'notification',
            method,
            params: payload as
              | QueryEventNotification
              | SessionClosedNotification
              | ClientReplacedNotification,
          }),
        );
      } catch {
        /* socket gone — registry.detachAll cleans up on disconnect */
      }
    };
  }

  /* ----------------------------- query/start ----------------------------- */
  const queryStart: MethodHandler = async (params, ctx) => {
    const p = (params ?? {}) as Partial<QueryStartParams>;
    requireString(p.sessionId, 'sessionId');
    requireString(p.cwd, 'cwd');
    requireString(p.model, 'model');
    if (typeof p.env !== 'object' || p.env === null) {
      throwInvalid('env must be an object');
    }
    // Reject in-process MCP configs at the protocol boundary (instance != serializable)
    if (p.mcpServers) {
      for (const [name, cfg] of Object.entries(p.mcpServers)) {
        if (typeof cfg === 'object' && cfg !== null && 'instance' in (cfg as object)) {
          throwInvalid(`mcpServers[${name}]: in-process 'instance' transport not supported in remote mode`);
        }
      }
    }
    try {
      const session = registry.create({
        sessionId: p.sessionId!,
        cwd: p.cwd!,
        model: p.model!,
        env: p.env as Record<string, string>,
        ...(p.mcpServers ? { mcpServers: p.mcpServers } : {}),
        ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}),
        ...(p.systemPrompt !== undefined ? { systemPrompt: p.systemPrompt } : {}),
        ...(p.additionalDirectories ? { additionalDirectories: p.additionalDirectories } : {}),
        ...(p.allowedTools ? { allowedTools: p.allowedTools } : {}),
        ...(p.disallowedTools ? { disallowedTools: p.disallowedTools } : {}),
        ...(p.tools !== undefined ? { tools: p.tools } : {}),
        ...(p.resumeSdkSessionId ? { resumeSdkSessionId: p.resumeSdkSessionId } : {}),
        ...(p.extraOptions ? { extraOptions: p.extraOptions } : {}),
      });
      // Auto-attach this client on start (typical flow — caller is the same
      // client that will consume events).
      // **sinceSeq: 0** 必须传: registry.create() 已经 spawn 了 SDK consume loop,
      // SDK 在 create() 返回到这里 attach() 之间可能已 emit initial system event
      // (含 sdk session_id metadata 等), 那条事件 已进 ring buffer。不传 sinceSeq
      // 会跳过 replay → client 永远拿不到 initial event, 历史 session_id 也丢。
      const notify = makeNotify(ctx as never);
      registry.attach(session.sessionId, notify, { sinceSeq: 0 });
      getSubs(ctx as never).bySession.set(session.sessionId, notify);
      attachedCtxBySession.set(session.sessionId, ctx as unknown as ClientCtx);
      const result: QueryStartResult = {
        sessionId: session.sessionId,
        ...(session.sdkSessionId ? { sdkSessionId: session.sdkSessionId } : {}),
      };
      return result;
    } catch (err) {
      throw mapRegistryError(err);
    }
  };

  /* ----------------------------- query/send ----------------------------- */
  const querySend: MethodHandler = async (params) => {
    const p = (params ?? {}) as Partial<QuerySendParams>;
    requireString(p.sessionId, 'sessionId');
    if (p.message === undefined) throwInvalid('message is required');
    try {
      registry.sendMessage(p.sessionId!, p.message);
      return { ok: true };
    } catch (err) {
      throw mapRegistryError(err);
    }
  };

  /* ----------------------------- query/setModel ----------------------------- */
  const querySetModel: MethodHandler = async (params) => {
    const p = (params ?? {}) as Partial<QuerySetModelParams>;
    requireString(p.sessionId, 'sessionId');
    requireString(p.model, 'model');
    try {
      await registry.setModel(p.sessionId!, p.model!);
      return { ok: true };
    } catch (err) {
      throw mapRegistryError(err);
    }
  };

  /* ----------------------------- query/setPermissionMode ----------------------------- */
  const querySetPermissionMode: MethodHandler = async (params) => {
    const p = (params ?? {}) as Partial<QuerySetPermissionModeParams>;
    requireString(p.sessionId, 'sessionId');
    requireString(p.mode, 'mode');
    try {
      await registry.setPermissionMode(p.sessionId!, p.mode!);
      return { ok: true };
    } catch (err) {
      throw mapRegistryError(err);
    }
  };

  /* ----------------------------- query/applyFlagSettings ----------------------------- */
  const queryApplyFlagSettings: MethodHandler = async (params) => {
    const p = (params ?? {}) as Partial<QueryApplyFlagSettingsParams>;
    requireString(p.sessionId, 'sessionId');
    if (typeof p.settings !== 'object' || p.settings === null) {
      throwInvalid('settings must be an object');
    }
    try {
      await registry.applyFlagSettings(p.sessionId!, p.settings as Record<string, unknown>);
      return { ok: true };
    } catch (err) {
      throw mapRegistryError(err);
    }
  };

  /* ----------------------------- query/getContextUsage ----------------------------- */
  const queryGetContextUsage: MethodHandler = async (params) => {
    const p = (params ?? {}) as Partial<QueryGetContextUsageParams>;
    requireString(p.sessionId, 'sessionId');
    try {
      return await registry.getContextUsage(p.sessionId!);
    } catch (err) {
      throw mapRegistryError(err);
    }
  };

  /* ----------------------------- query/interrupt ----------------------------- */
  const queryInterrupt: MethodHandler = async (params) => {
    const p = (params ?? {}) as Partial<QueryInterruptParams>;
    requireString(p.sessionId, 'sessionId');
    try {
      await registry.interrupt(p.sessionId!);
      return { ok: true };
    } catch (err) {
      throw mapRegistryError(err);
    }
  };

  /* ----------------------------- query/stopTask ----------------------------- */
  const queryStopTask: MethodHandler = async (params) => {
    const p = (params ?? {}) as Partial<QueryStopTaskParams>;
    requireString(p.sessionId, 'sessionId');
    requireString(p.taskId, 'taskId');
    try {
      await registry.stopTask(p.sessionId!, p.taskId!);
      return { ok: true };
    } catch (err) {
      throw mapRegistryError(err);
    }
  };

  /* ----------------------------- query/close ----------------------------- */
  const queryClose: MethodHandler = async (params, ctx) => {
    const p = (params ?? {}) as Partial<QueryCloseParams>;
    requireString(p.sessionId, 'sessionId');
    await registry.close(p.sessionId!);
    // Detach any subscription this client had on this session.
    const subs = getSubs(ctx as never);
    const notify = subs.bySession.get(p.sessionId!);
    if (notify) {
      registry.detachIfCurrent(p.sessionId!, notify);
      subs.bySession.delete(p.sessionId!);
    }
    attachedCtxBySession.delete(p.sessionId!);
    return { ok: true };
  };

  /* ----------------------------- session/attach ----------------------------- */
  const sessionAttach: MethodHandler = async (params, ctx) => {
    const p = (params ?? {}) as Partial<SessionAttachParams>;
    requireString(p.sessionId, 'sessionId');
    try {
      // Reject any in-flight approval requests bound to the old ctx before replacing.
      const oldCtx = attachedCtxBySession.get(p.sessionId!);
      if (oldCtx && oldCtx !== ctx) {
        server.rejectPendingForCtx(oldCtx);
      }
      const notify = makeNotify(ctx as never);
      const r = registry.attach(p.sessionId!, notify, {
        ...(p.sinceSeq !== undefined ? { sinceSeq: p.sinceSeq } : {}),
      });
      getSubs(ctx as never).bySession.set(p.sessionId!, notify);
      attachedCtxBySession.set(p.sessionId!, ctx as unknown as ClientCtx);
      const result: SessionAttachResult = {
        sessionId: p.sessionId!,
        currentSeq: r.currentSeq,
        alive: r.alive,
        replayLossy: r.replayLossy,
      };
      return result;
    } catch (err) {
      throw mapRegistryError(err);
    }
  };

  /* ----------------------------- session/list ----------------------------- */
  const sessionList: MethodHandler = async () => {
    const result: SessionListResult = { sessions: registry.list() };
    return result;
  };

  /* ----------------------------- session/kill ----------------------------- */
  const sessionKill: MethodHandler = async (params) => {
    const p = (params ?? {}) as Partial<SessionKillParams>;
    requireString(p.sessionId, 'sessionId');
    await registry.kill(p.sessionId!);
    attachedCtxBySession.delete(p.sessionId!);
    return { ok: true };
  };

  server.setHandler(METHODS.QUERY_START, queryStart);
  server.setHandler(METHODS.QUERY_SEND, querySend);
  server.setHandler(METHODS.QUERY_SET_MODEL, querySetModel);
  server.setHandler(METHODS.QUERY_SET_PERMISSION_MODE, querySetPermissionMode);
  server.setHandler(METHODS.QUERY_APPLY_FLAG_SETTINGS, queryApplyFlagSettings);
  server.setHandler(METHODS.QUERY_GET_CONTEXT_USAGE, queryGetContextUsage);
  server.setHandler(METHODS.QUERY_INTERRUPT, queryInterrupt);
  server.setHandler(METHODS.QUERY_STOP_TASK, queryStopTask);
  server.setHandler(METHODS.QUERY_CLOSE, queryClose);
  server.setHandler(METHODS.SESSION_ATTACH, sessionAttach);
  server.setHandler(METHODS.SESSION_LIST, sessionList);
  server.setHandler(METHODS.SESSION_KILL, sessionKill);

  return {
    getAttachedClientCtx: (sessionId: string) => {
      const ctx = attachedCtxBySession.get(sessionId);
      if (ctx && ctx.socket.destroyed) {
        attachedCtxBySession.delete(sessionId);
        return undefined;
      }
      return ctx;
    },
    onClientDisconnected: (ctx: ClientCtx) => {
      for (const [sid, c] of attachedCtxBySession) {
        if (c === ctx) attachedCtxBySession.delete(sid);
      }
    },
  };
}

/* ============================== helpers ============================== */

function requireString(v: unknown, field: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) {
    throwInvalid(`${field} must be a non-empty string`);
  }
}

interface ThrowableInvalid extends Error {
  code: 'INVALID_PARAMS';
}

function throwInvalid(message: string): never {
  const err = new Error(message) as ThrowableInvalid;
  err.code = 'INVALID_PARAMS';
  throw err;
}

/**
 * Map registry errors (.code) to RPC errors (.code). Anything without a
 * recognized code is re-thrown as INTERNAL.
 */
function mapRegistryError(err: unknown): Error {
  const e = err as { code?: string; message?: string };
  const code =
    e.code === 'SESSION_NOT_FOUND' ||
    e.code === 'SESSION_ALREADY_EXISTS' ||
    e.code === 'SESSION_KILL_PENDING' ||
    e.code === 'SESSION_KILL_TIMEOUT' ||
    e.code === 'SDK_ERROR' ||
    e.code === 'INVALID_PARAMS'
      ? e.code
      : 'SDK_ERROR';
  const out = new Error(e.message ?? 'unknown error') as Error & { code: string };
  out.code = code;
  return out;
}
