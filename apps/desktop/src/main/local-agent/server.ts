/**
 * Same-computer Agent API v1. User consent grants this API its own credential;
 * supplier credentials remain behind the existing desktop Host boundary.
 * The transport is injectable so authorization/lifecycle tests never read a real profile.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalAgentModel } from './catalog.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import type { LocalAgentInstanceInfo } from '../../shared/localAgent.js';

const MAX_BODY = 16 * 1024 * 1024;
const MAX_EVENTS = 8 * 1024 * 1024;
const MAX_RUNS = 16;
const PAIR_TTL = 120_000;
const RUN_IDLE = 3 * 60_000;
const MAX_CLIENTS = 128;
const MAX_GRANT_CLIENTS = 32;
const MAX_RETIRED_CLIENTS = 4096;
const CLIENT_IDLE_MS = 10 * 60_000;
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class LocalAgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LocalAgentOpen {
  /** Server-issued grant identity; never taken from session/open parameters. */
  isolationKey: string;
  mcpName: string;
  legacyRuntime: boolean;
  cwd: string;
  model: LocalAgentModel;
  effort?: string;
  instructions?: string;
  access: 'none' | 'full';
  resume?: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}
export interface LocalAgentRuntime {
  id: string;
  resumed: boolean;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export interface LocalAgentClientIdentity {
  id: string;
  name: string;
  version?: string;
}
interface Grant {
  id: string;
  name: string;
  hash: string;
  scope: string;
  client: LocalAgentClientIdentity;
  legacyRuntime: boolean;
}
interface Pair {
  id: string;
  claim: string;
  client: LocalAgentClientIdentity;
  scope: string;
  expires: number;
  state: 'waiting' | 'approved' | 'denied';
  secret?: string;
  grant?: Grant;
  approval?: Promise<void>;
  consent?: AbortController;
}
interface Run {
  owner: string;
  runtime?: LocalAgentRuntime;
  touched: number;
  seq: number;
  events: Array<{ seq: number; event: unknown; bytes: number }>;
  bytes: number;
  waiters: Set<() => void>;
  closed: boolean;
  tools: LocalAgentOpen['tools'];
  mcpToken: string;
  pending: Map<string, { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>;
  resumeKey?: string;
  closing?: Promise<void>;
  /** A revoke during startup must wait for the late runtime and confirm its close. */
  opening?: Promise<LocalAgentRuntime>;
}
export interface LocalAgentServerDeps {
  directory: string;
  discoveryDirectory?: string;
  version: string;
  instanceInfo?: Readonly<LocalAgentInstanceInfo>;
  scope(): string;
  models(): Promise<LocalAgentModel[]>;
  approve(signal: AbortSignal, client: LocalAgentClientIdentity): Promise<boolean>;
  open(
    input: LocalAgentOpen,
    bridge: { url: string; token: string; emit(event: unknown): void },
  ): Promise<LocalAgentRuntime>;
  warn(code: string): void;
  changed?(): void;
  /** Product copy is supplied by the host's current locale; protocol tests remain host-free. */
  message?(code: string, fallback: string): string;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new LocalAgentError('INVALID_REQUEST', '请求格式不正确。');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.length) || value.length > max)
    throw new LocalAgentError('INVALID_REQUEST', '请求字段无效或过长。');
  return value;
}
function displayText(value: unknown, max: number): string {
  const result = text(value, max).trim();
  if (!result || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(result)) {
    throw new LocalAgentError('INVALID_CLIENT', '应用名称或版本无效。');
  }
  return result;
}
function clientIdentity(value: unknown): LocalAgentClientIdentity {
  // v1 accepted a display-name string. Keep that wire shape for any local client.
  if (typeof value === 'string') {
    const name = displayText(value, 80);
    return { id: `legacy.${hash(name)}`, name };
  }
  const client = record(value),
    id = text(client.id, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
    throw new LocalAgentError('INVALID_CLIENT', '应用编号无效。');
  return {
    id,
    name: displayText(client.name, 80),
    ...(client.version !== undefined ? { version: displayText(client.version, 64) } : {}),
  };
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new LocalAgentError('TOO_LARGE', '请求超过本机接入上限。');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof LocalAgentError) throw error;
    throw new LocalAgentError('INVALID_REQUEST', '请求不是有效 JSON。');
  }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

export async function createLocalAgentServer(deps: LocalAgentServerDeps) {
  const message = (code: string, fallback: string) => deps.message?.(code, fallback) ?? fallback;
  await fs.mkdir(deps.directory, { recursive: true, mode: 0o700 });
  const grantFile = path.join(deps.directory, 'grants.json');
  let grants: Grant[] = [];
  let legacyStore: string | undefined;
  let bindings: Record<string, { owner: string; model: string; native: string }> = {};
  try {
    const stat = await fs.stat(grantFile).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return fs.stat(`${grantFile}.bak`);
    });
    if (stat.size > 20 * 1024 * 1024) throw new Error('oversize');
    const original = readAtomicFileSync(grantFile);
    if (original === null)
      throw new LocalAgentError('GRANT_STORE_INVALID', '本机应用授权记录无法读取。');
    const saved = record(JSON.parse(original));
    if (
      ![1, 2].includes(saved.version as number) ||
      !Array.isArray(saved.grants) ||
      saved.grants.length > 32
    )
      throw new Error('schema');
    const ids = new Set<string>();
    grants = saved.grants.map((entry) => {
      const g = record(entry),
        id = text(g.id, 128),
        digest = text(g.hash, 64);
      if (ids.has(id) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('grant');
      ids.add(id);
      const client = clientIdentity(saved.version === 1 ? g.name : g.client);
      return {
        id,
        name: client.name,
        hash: digest,
        scope: text(g.scope),
        client,
        legacyRuntime: saved.version === 1 || g.legacyRuntime === true,
      };
    });
    if (saved.bindings !== undefined) {
      const entries = Object.entries(record(saved.bindings));
      if (entries.length > 4096) throw new Error('bindings');
      bindings = Object.fromEntries(
        entries.map(([id, value]) => {
          const b = record(value);
          return [
            text(id, 128),
            { owner: text(b.owner), model: text(b.model), native: text(b.native, 4096) },
          ];
        }),
      );
    }
    if (saved.version === 1) legacyStore = original;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new LocalAgentError('GRANT_STORE_INVALID', '本机应用授权记录无法读取，原文件已保留。');
  }
  let persistence = Promise.resolve();
  // A failed write must not let a revoked grant come back from disk after restart.
  let unsaved = false;
  const persist = () => {
    const value = JSON.stringify({ version: 2, grants, bindings });
    const write = async () => {
      if (legacyStore !== undefined) {
        try {
          await fs.writeFile(`${grantFile}.v1.bak`, legacyStore, { mode: 0o600, flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      atomicWriteFileSync(grantFile, value);
      legacyStore = undefined;
      unsaved = false;
    };
    const result = persistence.then(write, write);
    persistence = result.catch(() => {
      unsaved = true;
    });
    return result;
  };
  const pairs = new Map<string, Pair>();
  const runs = new Map<string, Run>();
  const dedup = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  const clients = new Map<string, { high: number; seen: number }>();
  // Reclaimed process nonces are refused rather than forgotten: a late retry under one
  // of them must not re-run a side effect whose dedup record was dropped.
  const retired = new Set<string>();
  const retire = (client: string) => {
    clients.delete(client);
    for (const key of dedup.keys()) if (key.startsWith(`${client}:`)) dedup.delete(key);
    retired.add(client);
    if (retired.size > MAX_RETIRED_CLIENTS) retired.delete(retired.values().next().value!);
  };
  const admitClient = (client: string, owner: string) => {
    if (retired.has(client))
      throw new LocalAgentError('REQUEST_EXPIRED', '该进程的请求记录已回收，请使用新的进程编号。');
    const owned = () => [...clients.keys()].filter((key) => key.startsWith(`${owner}:`)).length;
    if (clients.size < MAX_CLIENTS && owned() < MAX_GRANT_CLIENTS) return;
    // Restarted processes use new nonces; reclaim the ones that have gone quiet.
    const idle = Date.now() - CLIENT_IDLE_MS;
    for (const [key, state] of clients) if (state.seen <= idle) retire(key);
    if (clients.size >= MAX_CLIENTS || owned() >= MAX_GRANT_CLIENTS)
      throw new LocalAgentError('CLIENT_LIMIT', '本机连接数量已满，请稍后重试或在 Cindy 中重新授权。');
  };
  let base = '';
  let closing = false;
  /** Closes of engines that were still starting when their run was closed, by grant. */
  const lateCloses = new Map<Promise<void>, string>();
  const lateClosed = (owner?: string) =>
    Promise.all(
      [...lateCloses].filter(([, o]) => owner === undefined || o === owner).map(([p]) => p),
    );
  const closeRun = async (id: string, expected?: Run) => {
    const run = runs.get(id);
    if (!run || (expected && expected !== run)) return;
    if (run.closing) return run.closing;
    run.closed = true;
    for (const pending of run.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        content: [{ type: 'text', text: message('SESSION_UNAVAILABLE', '执行已关闭。') }],
        isError: true,
      });
    }
    run.pending.clear();
    for (const wake of run.waiters) wake();
    if (!run.runtime && run.opening) {
      // Free the session ID now; revocation still waits until the late engine is closed.
      runs.delete(id);
      const settled = run.opening.then(
        async (runtime) => {
          try {
            await runtime.close();
          } catch {
            deps.warn('RUNTIME_CLOSE_UNCONFIRMED');
            runs.set(`late:${token()}`, run); // closed run kept for a later close retry
            throw new LocalAgentError(
              'RUNTIME_CLOSE_UNCONFIRMED',
              '连接已失效，但尚未确认执行进程停止。',
            );
          }
        },
        () => {},
      );
      lateCloses.set(settled, run.owner);
      void settled.catch(() => {}).finally(() => lateCloses.delete(settled));
      return;
    }
    run.closing = (async () => {
      try {
        await run.runtime?.close();
      } catch {
        deps.warn('RUNTIME_CLOSE_UNCONFIRMED');
        throw new LocalAgentError(
          'RUNTIME_CLOSE_UNCONFIRMED',
          '连接已失效，但尚未确认执行进程停止。',
        );
      }
      if (runs.get(id) === run) runs.delete(id);
    })();
    try {
      await run.closing;
    } finally {
      run.closing = undefined;
    }
  };
  const syncBinding = async (run: Run) => {
    const binding = run.resumeKey && bindings[run.resumeKey];
    if (binding && run.runtime && binding.native !== run.runtime.id) {
      binding.native = run.runtime.id;
      await persist();
    }
  };
  const emit = (id: string, event: unknown) => {
    const run = runs.get(id);
    if (!run || run.closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > MAX_BODY || run.bytes + bytes > MAX_EVENTS) {
      deps.warn('EVENT_BACKPRESSURE');
      void closeRun(id).catch(() => {});
      return;
    }
    run.events.push({ seq: ++run.seq, event, bytes });
    run.bytes += bytes;
    // Claude/Codex can learn the durable native ID only after the first send.
    if (event && typeof event === 'object' && (event as { type?: unknown }).type === 'turn_end')
      void syncBinding(run).catch(() => deps.warn('RESUME_PERSIST_FAILED'));
    for (const wake of run.waiters) wake();
  };
  const requireRun = (id: string, owner: string) => {
    const run = runs.get(id);
    if (!run || run.owner !== owner || run.closed)
      throw new LocalAgentError(
        'SESSION_UNAVAILABLE',
        'Cindy 会话已关闭，请重新发送消息以接续会话。',
      );
    run.touched = Date.now();
    return run;
  };
  const authorize = (req: IncomingMessage) => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer '))
      throw new LocalAgentError('UNAUTHORIZED', '请先在 Cindy 中允许连接。');
    const digest = hash(authorization.slice(7));
    const grant = grants.find((g) => g.scope === deps.scope() && equal(g.hash, digest));
    if (!grant) throw new LocalAgentError('UNAUTHORIZED', 'Cindy 连接授权已失效，请重新连接。');
    return grant;
  };
  const assertGrant = (grant: Grant) => {
    if (closing || !grants.includes(grant) || grant.scope !== deps.scope())
      throw new LocalAgentError('UNAUTHORIZED', '连接授权已撤销或账号已更改。');
  };
  const runKey = (grant: Grant, id: string) => hash(JSON.stringify([grant.id, id]));
  const revoke = async (id: string) => {
    const found = grants.some((grant) => grant.id === id && grant.scope === deps.scope());
    if (!found) return false;
    // Remove authority before awaiting disk or runtime cleanup. Other grants stay live.
    grants = grants.filter((grant) => grant.id !== id);
    bindings = Object.fromEntries(
      Object.entries(bindings).filter(([, binding]) => binding.owner !== id),
    );
    for (const [key, pair] of pairs)
      if (pair.grant?.id === id) {
        pair.consent?.abort();
        pairs.delete(key);
      }
    for (const key of dedup.keys()) if (key.startsWith(`${id}:`)) dedup.delete(key);
    for (const key of clients.keys()) if (key.startsWith(`${id}:`)) clients.delete(key);
    for (const key of retired) if (key.startsWith(`${id}:`)) retired.delete(key);
    const stopped = Promise.all(
      [...runs].filter(([, run]) => run.owner === id).map(([key]) => closeRun(key)),
    ).then(() => lateClosed(id));
    try {
      await Promise.all([persist(), stopped]);
    } finally {
      deps.changed?.();
    }
    return true;
  };
  const operation = async (
    method: string,
    p: Record<string, unknown>,
    grant: Grant,
  ): Promise<unknown> => {
    assertGrant(grant);
    if (method === 'models') {
      const models = await deps.models();
      assertGrant(grant);
      return { models };
    }
    if (method === 'connect/revoke') {
      await revoke(grant.id);
      return {};
    }
    if (method === 'session/open') {
      if (runs.size >= MAX_RUNS)
        throw new LocalAgentError('BUSY', 'Cindy 本机接入的会话已满，请先结束不再使用的会话。');
      const sessionId = text(p.sessionId, 128),
        id = runKey(grant, sessionId);
      if (runs.has(id)) throw new LocalAgentError('SESSION_EXISTS', '会话编号已被使用。');
      const models = await deps.models();
      const model = models.find((m) => m.id === p.model);
      if (!model)
        throw new LocalAgentError(
          'MODEL_UNAVAILABLE',
          '所选模型或供应商已不可用，请在 Cindy 中检查后重新选择。',
        );
      const cwd = text(p.cwd, 32768);
      if (!path.isAbsolute(cwd) || !(await fs.stat(cwd).catch(() => undefined))?.isDirectory())
        throw new LocalAgentError('INVALID_WORKSPACE', '工作目录不存在或不是绝对路径。');
      const effort = text(p.effort, 64, true) || undefined;
      if (effort && !model.efforts.includes(effort))
        throw new LocalAgentError('INVALID_EFFORT', '所选模型不支持这个思考力度。');
      const access =
        p.toolPolicy === 'client-only' ? 'none' : p.toolPolicy === 'native' ? 'full' : p.access;
      if (
        (p.toolPolicy !== undefined &&
          !['client-only', 'native'].includes(p.toolPolicy as string)) ||
        (access !== 'none' && access !== 'full') ||
        (p.access !== undefined && p.access !== access)
      ) {
        throw new LocalAgentError('UNSUPPORTED_ACCESS', '工具策略无效；此接口不声明原生只读保证。');
      }
      if (!Array.isArray(p.tools) || p.tools.length > 256)
        throw new LocalAgentError('INVALID_REQUEST', '宿主工具清单无效。');
      const names = new Set<string>();
      const tools = p.tools.map((raw) => {
        const t = record(raw),
          name = text(t.name, 64);
        if (!/^[a-zA-Z0-9_-]+$/.test(name) || names.has(name))
          throw new LocalAgentError('INVALID_REQUEST', '宿主工具名称无效或重复。');
        names.add(name);
        return {
          name,
          description: text(t.description, 32768, true),
          parameters: record(t.parameters),
        };
      });
      const resumeKey = text(p.resume, 128, true) || undefined;
      const previous = resumeKey ? bindings[resumeKey] : undefined;
      if (resumeKey && (!previous || previous.owner !== grant.id))
        throw new LocalAgentError(
          'RESUME_UNAVAILABLE',
          '原 Cindy 会话无法在此授权下恢复，未重新执行消息。',
        );
      // A deliberate model/source change starts a fresh engine session. The client sees
      // resumed:false and supplies its existing context handoff, without replaying
      // any old tool call or resuming a supplier's thread with another model.
      const binding = previous?.model === model.id ? previous : undefined;
      if (Object.keys(bindings).length >= 4096 && !binding)
        throw new LocalAgentError(
          'RESUME_LIMIT',
          '本机接入的恢复记录已满，请在 Cindy 中撤销连接后重新连接。',
        );
      assertGrant(grant);
      if (runs.has(id)) throw new LocalAgentError('SESSION_EXISTS', '会话编号已被此连接使用。');
      if (runs.size >= MAX_RUNS) throw new LocalAgentError('BUSY', 'Cindy 本机接入的会话已满。');
      const run: Run = {
        owner: grant.id,
        touched: Date.now(),
        seq: 0,
        events: [],
        bytes: 0,
        waiters: new Set(),
        closed: false,
        tools,
        mcpToken: token(),
        pending: new Map(),
      };
      runs.set(id, run);
      try {
        run.opening = deps.open(
          {
            isolationKey: hash(grant.id),
            mcpName: grant.legacyRuntime ? 'hhh' : 'client',
            legacyRuntime: grant.legacyRuntime,
            cwd,
            model,
            effort,
            instructions: text(p.instructions, 1024 * 1024, true),
            access,
            resume: binding?.native,
            tools,
          },
          {
            url: `${base}/mcp/${id}`,
            token: run.mcpToken,
            emit: (event) => {
              if (runs.get(id) === run) emit(id, event);
            },
          },
        );
        run.runtime = await run.opening;
        // The catch below joins any revoke already closing this run instead of closing twice.
        if (run.closed || !grants.includes(grant) || grant.scope !== deps.scope())
          throw new LocalAgentError('UNAUTHORIZED', '连接已失效。');
        // Another open may have used the last slot while this engine started.
        if (!binding && Object.keys(bindings).length >= 4096)
          throw new LocalAgentError(
            'RESUME_LIMIT',
            '本机接入的恢复记录已满，请在 Cindy 中撤销连接后重新连接。',
          );
        run.resumeKey = binding && resumeKey ? resumeKey : token();
        const key = run.resumeKey,
          prior = bindings[key],
          added = { owner: grant.id, model: model.id, native: run.runtime.id };
        bindings[key] = added;
        try {
          await persist();
        } catch (error) {
          // The caller never receives this handle; keep a resumable prior binding intact.
          if (bindings[key] === added) {
            if (prior) bindings[key] = prior;
            else delete bindings[key];
          }
          throw error;
        }
        assertGrant(grant);
        return { id: run.resumeKey, resumed: run.runtime.resumed, sessionId };
      } catch (error) {
        await closeRun(id, run);
        throw error;
      }
    }
    const id = runKey(grant, text(p.sessionId, 128));
    const run = requireRun(id, grant.id);
    if (method === 'events') {
      const cursor = p.cursor;
      if (!Number.isSafeInteger(cursor) || (cursor as number) < 0 || (cursor as number) > run.seq)
        throw new LocalAgentError('INVALID_CURSOR', '事件游标无效。');
      // Acknowledgement allows reclamation; a lost poll response is replayable from its old cursor.
      while (run.events[0] && run.events[0].seq <= (cursor as number))
        run.bytes -= run.events.shift()!.bytes;
      if (!run.events.length && !run.closed)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            run.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, 20_000);
          run.waiters.add(done);
        });
      if (run.closed || requireRun(id, grant.id) !== run)
        throw new LocalAgentError('SESSION_UNAVAILABLE', '原会话已关闭。');
      if (!grants.includes(grant) || grant.scope !== deps.scope())
        throw new LocalAgentError('UNAUTHORIZED', '连接授权已撤销。');
      let bytes = 0;
      const events: Array<{ seq: number; event: unknown }> = [];
      for (const entry of run.events) {
        if (entry.seq <= (cursor as number)) continue;
        if (bytes && bytes + entry.bytes > 1024 * 1024) break;
        bytes += entry.bytes;
        events.push({ seq: entry.seq, event: entry.event });
      }
      return { events, cursor: events.at(-1)?.seq ?? cursor };
    }
    if (method === 'session/close') {
      await closeRun(id);
      return {};
    }
    if (method === 'tool/reply') {
      const callId = text(p.callId, 128);
      const pending = run.pending.get(callId);
      if (!pending)
        throw new LocalAgentError('TOOL_UNAVAILABLE', '该工具请求已结束，结果没有重复执行。');
      const reply = {
        content: [{ type: 'text', text: text(p.text, 4 * 1024 * 1024, true) }],
        isError: p.isError === true,
      };
      run.pending.delete(callId);
      clearTimeout(pending.timer);
      pending.resolve(reply);
      return {};
    }
    if (!['send', 'steer', 'interrupt', 'instructions'].includes(method))
      throw new LocalAgentError('METHOD_UNSUPPORTED', '此 Cindy 版本不支持该会话操作。');
    if (!run.runtime) throw new LocalAgentError('SESSION_STARTING', 'Cindy 会话还在启动。');
    const result = await run.runtime.call(method, p);
    await syncBinding(run);
    return result;
  };
  const approvePair = (pair: Pair): Promise<void> => {
    if (pair.approval) return pair.approval;
    pair.consent = new AbortController();
    pair.approval = (async () => {
      const approved = await deps.approve(pair.consent!.signal, pair.client);
      if (
        closing ||
        pairs.get(pair.id) !== pair ||
        pair.expires < Date.now() ||
        pair.scope !== deps.scope()
      )
        throw new LocalAgentError('PAIR_EXPIRED', '连接申请已过期或当前账号已更改。');
      if (approved) {
        const secret = token();
        const grant: Grant = {
          id: token(),
          name: pair.client.name,
          client: pair.client,
          legacyRuntime: false,
          hash: hash(secret),
          scope: pair.scope,
        };
        if (grants.length >= 32)
          throw new LocalAgentError('GRANT_LIMIT', '本机应用授权已满，请先撤销不用的连接。');
        grants.push(grant);
        try {
          await persist();
          if (pairs.get(pair.id) !== pair || pair.scope !== deps.scope()) {
            grants = grants.filter((g) => g !== grant);
            await persist();
            throw new LocalAgentError('PAIR_EXPIRED', '连接申请已取消。');
          }
        } catch (error) {
          grants = grants.filter((g) => g !== grant);
          throw error;
        }
        pair.secret = secret;
        pair.grant = grant;
        pair.state = 'approved';
        deps.changed?.();
      } else pair.state = 'denied';
    })();
    return pair.approval;
  };
  const server = createServer(async (req, res) => {
    try {
      if (closing) throw new LocalAgentError('SESSION_UNAVAILABLE', '本机应用连接已关闭。');
      const host = req.headers.host;
      if (host !== base.slice(7) || req.headers.origin)
        throw new LocalAgentError('FORBIDDEN', '此接口仅供已授权的本机应用使用。');
      if (req.method === 'GET' && req.url?.startsWith('/connect/')) {
        const pair = pairs.get(req.url.slice(9));
        if (!pair || pair.expires < Date.now())
          throw new LocalAgentError('PAIR_EXPIRED', '连接申请已过期，请回到申请的应用重新连接。');
        await approvePair(pair);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'",
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
        });
        const copy = message(
          'CONNECT_RESULT',
          '请回到申请的应用查看连接结果。连接授权由 Cindy 中的确认窗口决定。',
        );
        res.end(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cindy</title><p>${copy.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`,
        );
        return;
      }
      if (req.method === 'POST' && req.url?.startsWith('/mcp/')) {
        const id = req.url.slice(5);
        const run = runs.get(id);
        if (
          !run ||
          run.closed ||
          !equal(req.headers.authorization ?? '', `Bearer ${run.mcpToken}`) ||
          !grants.some((g) => g.id === run.owner && g.scope === deps.scope())
        )
          throw new LocalAgentError('UNAUTHORIZED', '工具连接已失效。');
        const rpc = await body(req);
        const method = text(rpc.method);
        if (
          run.closed ||
          runs.get(id) !== run ||
          !grants.some((g) => g.id === run.owner && g.scope === deps.scope())
        ) {
          throw new LocalAgentError('UNAUTHORIZED', '工具连接已失效。');
        }
        if (!('id' in rpc)) {
          res.writeHead(202);
          res.end();
          return;
        }
        let result: unknown;
        if (method === 'initialize')
          result = {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'cindy-client-tools', version: '1' },
          };
        else if (method === 'tools/list')
          result = {
            tools: run.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
            })),
          };
        else if (method === 'ping') result = {};
        else if (method === 'tools/call') {
          const params = record(rpc.params);
          const name = text(params.name, 64);
          if (!run.tools.some((t) => t.name === name))
            throw new LocalAgentError('TOOL_UNAVAILABLE', '未登记此宿主工具。');
          if (run.pending.size >= 64) throw new LocalAgentError('BUSY', '等待中的宿主工具过多。');
          const arguments_ = record(params.arguments ?? {});
          const callId = token();
          result = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              run.pending.delete(callId);
              resolve({
                content: [
                  { type: 'text', text: message('TOOL_TIMEOUT', '宿主工具等待超时，未自动重试。') },
                ],
                isError: true,
              });
            }, 10 * 60_000);
            run.pending.set(callId, { resolve, timer });
            emit(id, { type: 'host_tool', data: { id: callId, name, arguments: arguments_ } });
          });
        } else throw new LocalAgentError('METHOD_UNSUPPORTED', '不支持此 MCP 操作。');
        json(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
        return;
      }
      if (
        req.method !== 'POST' ||
        req.url !== '/rpc' ||
        !req.headers['content-type']?.startsWith('application/json')
      )
        throw new LocalAgentError('INVALID_REQUEST', '需要有效的本机 RPC 请求。');
      const rpc = await body(req);
      const method = text(rpc.method, 64);
      const params = record(rpc.params ?? {});
      if (rpc.version !== 1)
        throw new LocalAgentError(
          'PROTOCOL_UNSUPPORTED',
          '本机 Agent 协议版本不兼容，请更新对应客户端。',
        );
      if (rpc.instance !== undefined && rpc.instance !== instanceId)
        throw new LocalAgentError('INSTANCE_CHANGED', 'Cindy 已重新启动，未重放旧实例中的操作。');
      if (method === 'capabilities') {
        json(res, 200, {
          result: {
            protocol: 1,
            version: deps.version,
            instance: instanceId,
            ...(deps.instanceInfo ? { instanceInfo: deps.instanceInfo } : {}),
            features: {
              ...(deps.instanceInfo ? { instanceMetadata: true } : {}),
              clientIdentity: true,
              isolatedSessions: true,
              individualRevocation: true,
              toolPolicy: true,
              nativeReadOnly: false,
            },
            methods: [
              'models',
              'session/open',
              'send',
              'steer',
              'interrupt',
              'instructions',
              'events',
              'tool/reply',
              'session/close',
              'connect/revoke',
            ],
          },
        });
        return;
      }
      if (method === 'connect/start') {
        if (pairs.size >= 8) throw new LocalAgentError('BUSY', '连接申请过多，请稍后再试。');
        const client = clientIdentity(params.client);
        const pair: Pair = {
          id: token(),
          claim: token(),
          client,
          scope: deps.scope(),
          expires: Date.now() + PAIR_TTL,
          state: 'waiting',
        };
        pairs.set(pair.id, pair);
        // Native consent is always raised on this computer, including remote viewing.
        void approvePair(pair).catch(() => {
          pair.state = 'denied';
          deps.warn('PAIR_FAILED');
        });
        json(res, 200, {
          result: { id: pair.id, claim: pair.claim, url: `${base}/connect/${pair.id}` },
        });
        return;
      }
      if (method === 'connect/poll' || method === 'connect/cancel') {
        const pair = pairs.get(text(params.id, 128));
        if (!pair || !equal(pair.claim, text(params.claim, 128)) || pair.expires < Date.now())
          throw new LocalAgentError('PAIR_EXPIRED', '连接申请已过期，请重新连接。');
        if (method === 'connect/cancel') {
          pair.consent?.abort();
          if (pair.grant) await revoke(pair.grant.id);
          pairs.delete(pair.id);
          json(res, 200, { result: {} });
          return;
        }
        json(res, 200, {
          result: { state: pair.state, ...(pair.secret ? { token: pair.secret } : {}) },
        });
        return;
      }
      const grant = authorize(req);
      if (method === 'events' || method === 'models') {
        json(res, 200, { result: await operation(method, params, grant) });
        return;
      }
      const id = text(rpc.id, 128);
      const key = `${grant.id}:${id}`;
      const identity = /^([A-Za-z0-9_-]{8,64}):([1-9][0-9]{0,14})$/.exec(id);
      if (!identity) throw new LocalAgentError('INVALID_REQUEST_ID', '请求编号格式无效。');
      const client = `${grant.id}:${identity[1]}`,
        counter = Number(identity[2]);
      if (!clients.has(client)) admitClient(client, grant.id);
      const state = clients.get(client) ?? { high: 0, seen: 0 };
      state.seen = Date.now();
      const high = state.high;
      if (counter <= high - 256)
        throw new LocalAgentError('REQUEST_EXPIRED', '请求记录已过期，未再次执行。');
      const fingerprint = hash(JSON.stringify([method, params]));
      const previous = dedup.get(key);
      if (previous && previous.fingerprint !== fingerprint)
        throw new LocalAgentError('ID_REUSED', '请求编号已用于不同操作，未再次执行。');
      if (!previous) {
        clients.set(client, { high: Math.max(high, counter), seen: state.seen });
        for (const old of dedup.keys())
          if (old.startsWith(`${client}:`) && Number(old.slice(client.length + 1)) <= counter - 256)
            dedup.delete(old);
        const result = operation(method, params, grant);
        result.catch(() => {});
        dedup.set(key, { fingerprint, result });
      }
      json(res, 200, { result: await dedup.get(key)!.result });
    } catch (error) {
      const known = error instanceof LocalAgentError;
      const code = known ? error.code : 'LOCAL_AGENT_FAILED';
      deps.warn(code);
      json(res, code === 'UNAUTHORIZED' || code === 'FORBIDDEN' ? 403 : 400, {
        error: {
          code,
          message: message(code, known ? error.message : 'Cindy 本机接入操作未完成。'),
        },
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local agent address unavailable');
  base = `http://127.0.0.1:${address.port}`;
  const instanceId = token();
  const discoveryDirectory = deps.discoveryDirectory ?? deps.directory;
  const discoveryFile = path.join(discoveryDirectory, 'discovery.json');
  try {
    await fs.mkdir(discoveryDirectory, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(
      discoveryFile,
      JSON.stringify({ protocol: 1, port: address.port, instance: instanceId }),
    );
  } catch {
    closing = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new LocalAgentError('DISCOVERY_UNAVAILABLE', '未能保存本机应用连接信息。');
  }
  const sweep = setInterval(() => {
    if (unsaved) {
      unsaved = false;
      void persist().catch(() => {});
    }
    for (const [id, pair] of pairs)
      if (pair.expires < Date.now() || pair.scope !== deps.scope()) {
        pair.consent?.abort();
        pairs.delete(id);
      }
    for (const [id, run] of runs)
      if (
        !run.closed &&
        (run.touched + RUN_IDLE < Date.now() ||
          !grants.some((g) => g.id === run.owner && g.scope === deps.scope()))
      )
        void closeRun(id).catch(() => {});
  }, 1000).unref();
  return {
    base,
    rpc: Object.freeze({ protocol: 1 as const, port: address.port, instance: instanceId }),
    discoveryFile,
    connections: () =>
      grants
        .filter((g) => g.scope === deps.scope())
        .map((g) => ({ id: g.id, name: g.name, clientId: g.client.id })),
    revoke,
    async revokeAll() {
      grants = [];
      bindings = {};
      for (const pair of pairs.values()) pair.consent?.abort();
      pairs.clear();
      dedup.clear();
      clients.clear();
      retired.clear();
      await Promise.all([
        persist(),
        Promise.all([...runs.keys()].map((id) => closeRun(id))).then(() => lateClosed()),
      ]);
      deps.changed?.();
    },
    async close() {
      closing = true;
      clearInterval(sweep);
      for (const pair of pairs.values()) pair.consent?.abort();
      pairs.clear();
      const stopped = await Promise.allSettled([...runs.keys()].map((id) => closeRun(id)));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await persistence;
      // The last retry decides whether a revocation survives restart; never report it as closed.
      const saved = unsaved ? await persist().then(() => true, () => false) : true;
      try {
        if (JSON.parse(await fs.readFile(discoveryFile, 'utf8')).instance === instanceId)
          await fs.rm(discoveryFile, { force: true });
      } catch {
        /* profile already closed */
      }
      if (!saved) {
        deps.warn('GRANT_PERSIST_FAILED');
        throw new LocalAgentError(
          'GRANT_PERSIST_FAILED',
          '本机应用授权变更未能写入磁盘，重启后已撤销的连接可能恢复。',
        );
      }
      const failed = stopped.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
