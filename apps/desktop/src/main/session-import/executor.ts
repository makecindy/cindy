/**
 * 导入执行：可中断、可续、可重复。
 *
 * - 每次导入一个请求编号；逐条进度写进账号私有目录的回执，退出或崩溃后下次打开导入页时续上；
 * - 同时最多导入 2 条；单条失败不影响其它条；
 * - 每条分步：建隐藏任务 → 复制原生资料（原生续做）→ 写消息 → 验证能接着做 → 显示任务；
 * - 「可以继续」以实际加载结果为准：原生副本加载失败就退回交接方式，同样能继续；
 * - 读取失败才算没导入成功：删除这次建的隐藏任务，不留半截任务。
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow } from 'electron';

import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, ownerScopedUserDataPath } from '../appSessionState.js';
import { getCurrentDbClientSnapshot, getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { resolveDefaultScheduleRoute, resolveNewTaskDefaultModelRoute } from '../maker-host/model-route-guard-live.js';
import { getNewMakerModelTuning, getRemoteNewMakerDefaults, getSelectedNewMakerRoute } from '../maker-host/newMakerDefaultsCache.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { SESSION_IMPORT_PROGRESS_CHANNEL } from '../../shared/sessionImport.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { buildImportHandoffMarker } from './handoff.js';
import { invalidateImportScan, resolveSourceSessions } from './scan.js';
import { adapterFor } from './sources/index.js';
import type {
  ImportItemIssue,
  ImportItemView,
  ImportJobView,
  NativeHarness,
  NativeMaterialization,
  SourceSession,
} from './types.js';
import { createMessageSink, runImportTx, writeImportCards } from './writer.js';

const log = createLogger('session-import');
const CONCURRENCY = 2;
const PROGRESS_THROTTLE_MS = 150;

class ImportEmptyError extends Error {
  constructor() {
    super('source produced no messages');
  }
}

/** 导入途中切换了账号：停在原账号的回执里，等该账号下次打开时续上。 */
class OwnerChangedError extends Error {
  constructor() {
    super('account changed during import');
  }
}

interface Job {
  view: ImportJobView;
  /** 发起账号（含登录代次）；写库、存回执、推送进度前都要与当前一致。 */
  owner: string;
  /** 发起时的数据库实例代次；账号切换会换实例。 */
  dbEpoch: number | null;
  /** 发起账号的数据身份（原生副本编号按它生成）。 */
  ownerId: string | undefined;
  receiptDir: string;
  pushStamp: ReturnType<typeof getActiveDataOwnerPushStamp>;
  keys: string[];
  controller: AbortController;
  lastEmit: number;
  emitTimer: NodeJS.Timeout | null;
}

const jobs = new Map<string, Job>();
const recoveredOwners = new Set<string>();
/** startImport 解析来源期间先占住的 key，避免两处同时发起时都通过「是否进行中」检查。 */
const reservedKeys = new Set<string>();

function receiptDir(): string {
  return ownerScopedUserDataPath('session-imports');
}

/** 绑定当前账号与数据库实例的新任务。 */
function newJob(view: ImportJobView, keys: string[]): Job {
  const db = getCurrentDbClientSnapshot();
  return {
    view,
    owner: activeOwnerScopeKey(),
    dbEpoch: db?.clientEpoch ?? null,
    ownerId: db?.userId,
    receiptDir: receiptDir(),
    pushStamp: getActiveDataOwnerPushStamp(),
    keys,
    controller: new AbortController(),
    lastEmit: 0,
    emitTimer: null,
  };
}

function ownerCurrent(job: Job): boolean {
  return activeOwnerScopeKey() === job.owner && (getCurrentDbClientSnapshot()?.clientEpoch ?? null) === job.dbEpoch;
}

function assertOwner(job: Job): void {
  if (!ownerCurrent(job)) throw new OwnerChangedError();
}

function persist(job: Job): void {
  try {
    fs.mkdirSync(job.receiptDir, { recursive: true });
    atomicWriteFileSync(path.join(job.receiptDir, `${job.view.requestId}.json`), JSON.stringify({ keys: job.keys, view: job.view }));
  } catch (err) {
    log.warn('session import receipt write failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

function emit(job: Job, force = false): void {
  const now = Date.now();
  const send = () => {
    job.lastEmit = Date.now();
    job.emitTimer = null;
    // 已经换了账号：原账号的进度不推给新账号的界面。
    if (!ownerCurrent(job)) return;
    const stamp = job.pushStamp;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        if (stamp === undefined) win.webContents.send(SESSION_IMPORT_PROGRESS_CHANNEL, job.view);
        else win.webContents.send(SESSION_IMPORT_PROGRESS_CHANNEL, job.view, stamp);
      } catch { /* window going away */ }
    }
    for (const listener of progressListeners) listener(job.view);
  };
  if (force || now - job.lastEmit >= PROGRESS_THROTTLE_MS) {
    if (job.emitTimer) clearTimeout(job.emitTimer);
    send();
  } else if (!job.emitTimer) {
    job.emitTimer = setTimeout(send, PROGRESS_THROTTLE_MS - (now - job.lastEmit));
  }
}

const progressListeners = new Set<(view: ImportJobView) => void>();
/** 远程（手机）等其它入口订阅进度。 */
export function onImportProgress(listener: (view: ImportJobView) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

/** 同一来源任务得到同一个 Cindy 任务 id（中断重试据此续上）。 */
export function importSessionId(source: string, sourceSessionId: string): string {
  const hex = createHash('sha256').update(`${source}\0${sourceSessionId}`).digest('hex').slice(0, 24);
  return `imp-${source}-${hex}`;
}

async function pickSessionId(source: string, sourceSessionId: string): Promise<string> {
  const base = importSessionId(source, sourceSessionId);
  const row = await getDbClient().queryOne<{ status: string; hiddenAt: number | null }>(
    'SELECT status, hidden_at AS hiddenAt FROM sessions WHERE id = ?',
    [base],
  );
  // 之前导入的任务已被用户删除：用新 id 重新导入，不复活被删的那条。
  if (row && row.status === 'deleted' && row.hiddenAt === null) return `${base}-${Date.now().toString(36)}`;
  return base;
}

/** 目标引擎与模型：原生来源用同名引擎，其它来源用新任务默认引擎；模型按新建任务口径解析。 */
/**
 * 导入后的模型：与「新建任务」同一口径，并且只选当前账号真正连接着的来源。
 * 用户选中的新任务默认正好是这个引擎时优先用它（仍要验证来源可用）；否则按新任务默认解析。
 */
async function resolveRoute(native: NativeHarness | undefined): Promise<{
  agentKind: NativeHarness; model: string; providerId: string | null; effort: string; permissionMode: string;
}> {
  const owner = activeOwnerScopeKey();
  const selected = getSelectedNewMakerRoute(owner);
  const selectedKind: NativeHarness | null = selected
    ? selected.harness === 'claude' ? 'cc' : selected.harness === 'codex' ? 'codex' : selected.harness === 'pi' ? 'pi' : null
    : null;
  const agentKind: NativeHarness = native ?? selectedKind ?? 'cc';
  const agent = agentKind === 'cc' ? 'claude-code' : agentKind;
  const draft = getRemoteNewMakerDefaults(agent);
  let route: { model: string; providerId: string | null } | null = null;
  if (selected && selectedKind === agentKind && selected.model) {
    route = await resolveDefaultScheduleRoute(agent, selected.providerId ?? null, selected.model).catch(() => null);
  }
  if (!route) route = await resolveNewTaskDefaultModelRoute(agent).catch(() => null);
  const model = route?.model ?? draft.model ?? '';
  const tuning = route?.providerId ? getNewMakerModelTuning(owner, agent, route.providerId, model) : {};
  return {
    agentKind,
    model,
    providerId: route ? route.providerId : (draft.providerId ?? null),
    effort: tuning.effort ?? (selected && selectedKind === agentKind ? selected.effort : undefined) ?? draft.effort ?? 'high',
    permissionMode: draft.permissionMode ?? 'auto',
  };
}

function itemView(job: Job, key: string): ImportItemView {
  const item = job.view.items.find((i) => i.key === key);
  if (!item) throw new Error(`unknown import item ${key}`);
  return item;
}

async function dirExists(dir: string | null): Promise<boolean> {
  if (!dir) return false;
  const stat = await fsp.stat(dir).catch(() => null);
  return !!stat?.isDirectory();
}

async function importOne(job: Job, key: string, source: SourceSession): Promise<void> {
  const item = itemView(job, key);
  const adapter = adapterFor(source.source);
  if (!adapter) {
    Object.assign(item, { status: 'failed', issue: 'read-failed' });
    return;
  }
  if (source.unsupportedVersion) {
    Object.assign(item, { status: 'failed', issue: 'unsupported-version' });
    return;
  }
  const signal = job.controller.signal;
  item.status = 'running';
  emit(job);
  const sessionId = await pickSessionId(source.source, source.sourceSessionId);
  const route = await resolveRoute(adapter.native);
  if (!ownerCurrent(job)) {
    Object.assign(item, { status: 'queued' });
    return;
  }
  const cwd = normalizeWorkingDirForStorage(source.cwd) ?? source.cwd;
  const now = Date.now();
  item.sessionId = sessionId;
  item.harness = route.agentKind;
  try {
    await runImportTx({
      action: 'begin',
      now,
      session: {
        id: sessionId,
        title: source.title,
        workingDir: cwd,
        workspaceKind: source.dialogue ? 'dialogue' : 'project',
        model: route.model || 'default',
        providerId: route.providerId,
        effort: route.effort,
        permissionMode: route.permissionMode,
        status: source.archived ? 'archived' : 'active',
        tokensUsed: 0,
        userSendAt: source.updatedAt,
        agentKind: route.agentKind,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      },
      record: {
        source: source.source,
        sourceSessionId: source.sourceSessionId,
        fingerprint: `${source.sizeBytes}:${source.updatedAt}`,
        version: source.unsupportedVersion ?? null,
        mode: adapter.native ? 'native' : 'handoff',
        originalCwd: source.cwd,
        requestId: job.view.requestId,
      },
    });

    let materialized: NativeMaterialization | null = null;
    if (adapter.native && adapter.materialize) {
      item.step = 'copy';
      emit(job);
      materialized = await adapter.materialize(source, {
        cindySessionId: sessionId,
        ownerId: job.ownerId,
        signal,
        route: { providerId: route.providerId, model: route.model },
      });
      assertOwner(job);
    }

    item.step = 'messages';
    emit(job);
    const sink = createMessageSink({
      sessionId,
      agentKind: adapter.native ? route.agentKind : null,
      startAt: source.createdAt || source.updatedAt || now,
      beforeWrite: () => {
        assertOwner(job);
        if (signal.aborted) throw new Error('cancelled');
      },
      onWritten: (count) => {
        item.messagesWritten = count;
        emit(job);
      },
    });
    for await (const message of adapter.read(source, { cindySessionId: sessionId, nativeSessionId: materialized?.sdkSessionId, signal })) {
      if (signal.aborted) throw new Error('cancelled');
      await sink.push(message);
    }
    // 读取在取消时会提前结束而不报错：半截历史不能当成导入完成。
    if (signal.aborted) throw new Error('cancelled');
    await sink.flush();
    item.messagesWritten = sink.written;
    // 一条都没读到：要么来源格式变了，要么原记录本来是空的。不留一个点开什么都没有的任务。
    if (sink.written === 0) throw new ImportEmptyError();

    item.step = 'verify';
    emit(job);
    let mode: 'native' | 'handoff' = 'handoff';
    let marker: Awaited<ReturnType<typeof buildImportHandoffMarker>> | undefined;
    let sdkSessionId: string | null = null;
    let nativeIssue: ImportItemIssue | null = null;
    if (materialized && adapter.verify) {
      const outcome = await adapter.verify(materialized, source).catch((err) => ({
        ok: false as const,
        reason: 'native-unloadable' as const,
        detail: err instanceof Error ? err.message : String(err),
      }));
      if (outcome.ok) {
        mode = 'native';
        sdkSessionId = materialized.sdkSessionId;
      } else {
        nativeIssue = 'native-unloadable';
        log.warn('native copy failed verification, falling back to handoff', { key, detail: outcome.detail });
      }
    }
    assertOwner(job);
    await writeImportCards({
      sessionId,
      agentKind: adapter.native ? route.agentKind : null,
      firstCreatedAt: sink.firstCreatedAt,
      lastCreatedAt: sink.lastCreatedAt,
      meta: {
        source: source.source,
        sourceLabel: adapter.label,
        importedAt: now,
        originalCwd: source.cwd,
        mode,
        harness: route.agentKind,
      },
    });
    if (mode === 'handoff') {
      marker = await buildImportHandoffMarker({ sessionId, fromLabel: adapter.label, toHarness: route.agentKind });
    }
    const missingDir = !source.dialogue && !!source.cwd && !(await dirExists(source.cwd));
    if (signal.aborted) throw new Error('cancelled');
    assertOwner(job);
    await runImportTx({
      action: 'commit',
      sessionId,
      now: Date.now(),
      status: missingDir ? 'action' : 'ready',
      mode,
      issue: missingDir ? 'missing-dir' : nativeIssue,
      unhide: true,
      sessionPatch: { sdkSessionId },
      ...(marker ? { marker } : {}),
    });
    Object.assign(item, {
      status: missingDir ? 'action' : 'ready',
      step: null,
      mode,
      issue: missingDir ? 'missing-dir' : null,
    });
  } catch (err) {
    if (err instanceof OwnerChangedError) {
      // 不碰另一个账号的数据库：隐藏的半成品留在原账号，等它下次打开时从这里续上。
      Object.assign(item, { status: 'queued', step: null, sessionId: null, messagesWritten: 0 });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = signal.aborted;
    log.warn('session import item failed', { key, cancelled, error: message });
    await runImportTx({ action: 'abort', sessionId, requestId: job.view.requestId }).catch(() => undefined);
    Object.assign(item, {
      status: cancelled ? 'cancelled' : 'failed',
      step: null,
      sessionId: null,
      issue: cancelled ? null : err instanceof ImportEmptyError ? 'empty' : (/ENOSPC/.test(message) ? 'disk-full' : 'read-failed'),
    });
  } finally {
    emit(job, true);
    persist(job);
  }
}

async function runJob(job: Job): Promise<void> {
  // 已登记的来源也要能读到：续做中断的导入时，这些条目在上次已经建了隐藏任务。
  const sources = await resolveSourceSessions(job.keys, { includeImported: true }).catch(() => new Map<string, SourceSession>());
  const queue = job.keys.filter((k) => {
    const item = itemView(job, k);
    if (item.status !== 'queued' && item.status !== 'running') return false;
    if (!sources.has(k)) {
      Object.assign(item, { status: 'failed', issue: 'not-found' });
      return false;
    }
    return true;
  });
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      if (!ownerCurrent(job)) return;
      if (job.controller.signal.aborted) {
        Object.assign(itemView(job, key), { status: 'cancelled' });
        continue;
      }
      await importOne(job, key, sources.get(key)!);
    }
  });
  await Promise.all(workers);
  if (!ownerCurrent(job)) {
    // 留在原账号的回执里（仍为进行中），该账号下次打开导入时续上。
    persist(job);
    jobs.delete(job.view.requestId);
    log.info('session import paused by account change', { requestId: job.view.requestId });
    return;
  }
  job.view.status = job.controller.signal.aborted ? 'cancelled' : 'done';
  job.view.finishedAt = Date.now();
  invalidateImportScan();
  persist(job);
  emit(job, true);
  log.info('session import job finished', {
    requestId: job.view.requestId,
    items: job.view.items.length,
    ready: job.view.items.filter((i) => i.status === 'ready').length,
    action: job.view.items.filter((i) => i.status === 'action').length,
    failed: job.view.items.filter((i) => i.status === 'failed').length,
  });
}

/** 开始导入。返回请求编号；进度通过 SESSION_IMPORT_PROGRESS_CHANNEL 推送。 */
export async function startImport(keys: string[]): Promise<ImportJobView> {
  // 桌面、手机与 Agent 可能同时发起：已经在另一次导入里排队或进行中的条目不重复导入。
  const inFlight = new Set<string>(reservedKeys);
  for (const other of jobs.values()) {
    if (other.view.status !== 'running') continue;
    for (const item of other.view.items) if (item.status === 'queued' || item.status === 'running') inFlight.add(item.key);
  }
  const unique = [...new Set(keys)].filter((k) => !inFlight.has(k));
  if (unique.length === 0) {
    const running = [...jobs.values()].find((j) => j.view.status === 'running' && keys.some((k) => j.keys.includes(k)));
    if (running) return running.view;
  }
  // 解析来源要等待：先占住这些 key，同时发起的另一次导入会跳过它们。
  for (const k of unique) reservedKeys.add(k);
  try {
    return await createJob(unique);
  } finally {
    for (const k of unique) reservedKeys.delete(k);
  }
}

async function createJob(unique: string[]): Promise<ImportJobView> {
  const sources = await resolveSourceSessions(unique);
  const view: ImportJobView = {
    requestId: randomUUID(),
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    items: unique.map((key) => {
      const s = sources.get(key);
      return {
        key,
        source: (s?.source ?? key.split(':')[0]) as ImportItemView['source'],
        title: s?.title ?? key,
        // 找不到（或已经在 Cindy 里）的直接记为没找到，不重复导入。
        status: s ? 'queued' : 'failed',
        step: null,
        messagesWritten: 0,
        mode: null,
        harness: null,
        issue: s ? null : 'not-found',
        sessionId: null,
      };
    }),
  };
  const job = newJob(view, unique);
  jobs.set(view.requestId, job);
  persist(job);
  void runJob(job).catch((err) => log.warn('session import job crashed', { error: err instanceof Error ? err.message : String(err) }));
  return view;
}

export function cancelImport(requestId: string): boolean {
  const job = jobs.get(requestId);
  if (!job || job.view.status !== 'running') return false;
  job.controller.abort();
  return true;
}

/** 当前账号最近一次导入（界面重新打开时恢复进度/结果）。 */
export function latestImportJob(): ImportJobView | null {
  const owner = activeOwnerScopeKey();
  let latest: Job | null = null;
  for (const job of jobs.values()) {
    if (job.owner === owner && (!latest || job.view.startedAt > latest.view.startedAt)) latest = job;
  }
  return latest?.view ?? null;
}

export function importJob(requestId: string): ImportJobView | null {
  return jobs.get(requestId)?.view ?? null;
}

/**
 * 续上上次退出或崩溃时没做完的导入（每个账号进程内只做一次）。
 * 已完成的条目不重做；做到一半的条目从头再来——写入按行键幂等，复制按同一编号覆盖。
 */
export async function recoverInterruptedImports(): Promise<void> {
  const owner = activeOwnerScopeKey();
  if (recoveredOwners.has(owner)) return;
  recoveredOwners.add(owner);
  let names: string[] = [];
  try {
    names = (await fsp.readdir(receiptDir())).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of names) {
    const raw = readAtomicFileSync(path.join(receiptDir(), name));
    if (!raw) continue;
    let parsed: { keys: string[]; view: ImportJobView };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed?.view || jobs.has(parsed.view.requestId)) continue;
    const view = parsed.view;
    if (view.status !== 'running') {
      // 已结束的结果保留在内存里，供界面查看；超过 7 天的回执清掉。
      if (view.finishedAt && Date.now() - view.finishedAt > 7 * 24 * 3600_000) {
        await fsp.rm(path.join(receiptDir(), name), { force: true }).catch(() => undefined);
        continue;
      }
      jobs.set(view.requestId, newJob(view, parsed.keys));
      continue;
    }
    for (const item of view.items) {
      if (item.status === 'running') Object.assign(item, { status: 'queued', step: null });
    }
    const job = newJob(view, parsed.keys);
    jobs.set(view.requestId, job);
    log.info('resuming interrupted session import', { requestId: view.requestId });
    void runJob(job).catch(() => undefined);
  }
}

/** 是否有正在进行的导入（应用更新重启前提示用）。 */
export function hasRunningImport(): boolean {
  for (const job of jobs.values()) if (job.view.status === 'running') return true;
  return false;
}

/**
 * 「选择文件夹」：原文件夹不存在的任务换到用户选的目录。Pi 的续做副本首行记录了工作目录，
 * 需要按新目录重新复制；Claude Code / Codex 在续做时按任务目录定位，改任务目录即可。
 */
export async function relocateImportedSession(sessionId: string, workingDir: string): Promise<void> {
  if (!(await dirExists(workingDir))) throw Object.assign(new Error('folder does not exist'), { code: 'INVALID_PARAMS' });
  const record = await getDbClient().queryOne<{ source: string; sourceSessionId: string }>(
    'SELECT source, source_session_id AS sourceSessionId FROM session_imports WHERE session_id = ?',
    [sessionId],
  );
  if (!record) throw Object.assign(new Error('not an imported task'), { code: 'NOT_FOUND' });
  const dir = normalizeWorkingDirForStorage(workingDir) ?? workingDir;
  let sdkPatch: { sdkSessionId?: string } = {};
  if (record.source === 'pi') {
    const key = `pi:${record.sourceSessionId}`;
    const source = (await resolveSourceSessions([key], { includeImported: true })).get(key);
    const adapter = adapterFor('pi');
    if (!source || !adapter?.materialize) {
      throw Object.assign(new Error('original Pi session is no longer available'), { code: 'NOT_FOUND' });
    }
    sdkPatch = {
      sdkSessionId: (await adapter.materialize({ ...source, cwd: dir }, {
        cindySessionId: sessionId,
        ownerId: getCurrentDbClientSnapshot()?.userId,
      })).sdkSessionId,
    };
  }
  await runImportTx({
    action: 'commit',
    sessionId,
    now: Date.now(),
    status: 'ready',
    issue: null,
    unhide: true,
    sessionPatch: { ...sdkPatch, workingDir: dir },
  });
  for (const job of jobs.values()) {
    const item = job.view.items.find((i) => i.sessionId === sessionId);
    if (item) {
      Object.assign(item, { status: 'ready', issue: null });
      emit(job, true);
      persist(job);
    }
  }
}
