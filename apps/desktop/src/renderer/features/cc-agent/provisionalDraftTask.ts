/**
 * 新建页的未发送任务（Cursor 式体验）：用户在新建页开始输入，本机就先把任务建出来——
 * 它立刻出现在任务列表里、标题随输入变化，Agent 也能像已有任务一样提前启动；输入清空
 * 就真正删掉；第一次发送时直接接着用这条任务，不再新建。
 *
 * 只覆盖本机普通项目与对话草稿：远程电脑 / SSH / Agent 在另一台电脑 / 工作区 / 可写目录
 * 的草稿不提前建任务。草稿里影响任务本身的设置变了就删掉重建（同一个 id：还没发送的任务
 * 是真删，id 可以复用）；发送时设置与提前建的不一致，也是先删掉再按原流程新建。
 *
 * 所有操作串行执行，避免「建到一半又删」与「发送接管」交错。Main 侧见
 * main/localDb/provisionalSessions.ts。
 */

import type { JSONContent } from '@tiptap/core';

import {
  getDataOwnerGeneration,
  isDataOwnerIdCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';
import { emitAutoTitlePreview, emitAutoTitlePreviewCleared } from '@/lib/sessionsBus';
import { sessionsStore } from '@/lib/sessionsStore';

import {
  getProvisionalDraftTaskId,
  setProvisionalDraftTaskId,
  subscribeProvisionalDraftTaskId,
} from './lib/provisionalDraftTaskId';

const log = createLogger('provisional-draft-task');

/** 建任务的参数：与新建页发送时传给 createSession 的同一组字段。 */
export interface ProvisionalDraftCreateArgs {
  id: string;
  agentKind: 'cc' | 'codex' | 'pi' | 'zcode';
  model: string;
  effort: string;
  permissionMode: string;
  fastMode?: boolean | 'ultrafast';
  planModeEnabled?: boolean;
  workingDir?: string;
  workspaceKind: 'project' | 'dialogue';
  extraDirs?: string[];
  writableDirs?: string[];
  remoteHostId?: string;
  agentDeviceId?: string;
  providerId?: string | null;
}

interface Current {
  id: string;
  key: string;
  session: Session;
  title: string | null;
  /** 建它时的账号：切换账号后它属于另一个账号的库，不能再接着用。 */
  owner: DataOwnerGeneration;
}

let current: Current | null = null;
let chain: Promise<unknown> = Promise.resolve();
/** 每建出一次未发送任务加一(同一个 id 删掉重建也算新的一次)。 */
let generation = 0;

function notify(): void {
  setProvisionalDraftTaskId(current?.id ?? null);
}

function serial<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.catch(() => undefined);
  return next;
}

/** 比较用的设置指纹：id 不参与；空数组与缺省、空串与缺省视为相同。 */
export function provisionalDraftArgsKey(args: ProvisionalDraftCreateArgs): string {
  const list = (dirs?: string[]) => (dirs && dirs.length > 0 ? [...dirs] : []);
  return JSON.stringify([
    args.agentKind,
    args.model,
    args.effort || '',
    args.permissionMode,
    args.fastMode ?? false,
    args.planModeEnabled ?? false,
    args.workingDir || '',
    args.workspaceKind,
    list(args.extraDirs),
    list(args.writableDirs),
    args.remoteHostId || '',
    args.agentDeviceId || '',
    args.providerId ?? null,
  ]);
}

/** 只有本机普通任务才提前建出来。 */
export function canOpenProvisionalDraftTask(args: ProvisionalDraftCreateArgs): boolean {
  return (
    !!args.model &&
    !args.remoteHostId &&
    !args.agentDeviceId &&
    (args.writableDirs?.length ?? 0) === 0 &&
    (args.workspaceKind === 'dialogue' || !!args.workingDir)
  );
}

export const provisionalDraftTaskId = getProvisionalDraftTaskId;

/** 当前账号的未发送任务 id：新建页打开时据此沿用；上一个账号留下的不算，先放手。 */
export function provisionalDraftTaskIdForCurrentOwner(): string | null {
  releaseForeignCurrent();
  return current?.id ?? null;
}
export const subscribeProvisionalDraftTask = subscribeProvisionalDraftTaskId;

/** 当前未发送任务是第几次建出来的；调用方据此只为新建出来的那一次做初始化。 */
export function provisionalDraftTaskGeneration(): number {
  return generation;
}

/**
 * 切换账号后旧账号的未发送任务不再归这里管：只放手，不去当前账号的库里删
 * (任务所在电脑会把它留作残留，等那个账号下次就绪时清理)。
 */
function releaseForeignCurrent(): void {
  if (!current || isDataOwnerIdCurrent(current.owner)) return;
  current = null;
  notify();
}

/** 删掉当前未发送任务。删不掉(Agent 关不掉等)时保留它，之后再试，不复用同一个 id 重建。 */
async function discardCurrent(): Promise<boolean> {
  releaseForeignCurrent();
  const target = current;
  if (!target) return true;
  let removed = false;
  try {
    const result = await window.electronAPI.maker.discardProvisionalSession?.(target.id);
    removed = !result?.remaining;
  } catch (error) {
    log.warn('discard provisional task failed', error);
  }
  if (!removed) return false;
  if (current === target) {
    current = null;
    notify();
  }
  if (target.title) emitAutoTitlePreviewCleared(target.id);
  // Removed outright (not marked deleted): the same id may be opened again if the user types again.
  sessionsStore.removeLocal(target.id);
  makerChatStore.purgeSession(target.id);
  return true;
}

/**
 * 确保存在一条按 `args` 建出来的未发送任务；设置不同就删掉重建。返回任务，建不出来返回 null
 * （例如模型暂不可用——发送时会按原流程报错，这里静默）。
 */
export function ensureProvisionalDraftTask(
  args: ProvisionalDraftCreateArgs,
): Promise<Session | null> {
  return serial(async () => {
    releaseForeignCurrent();
    const key = provisionalDraftArgsKey(args);
    if (current && current.id === args.id && current.key === key) return current.session;
    if (!(await discardCurrent())) return null;
    if (!canOpenProvisionalDraftTask(args)) return null;
    const owner = getDataOwnerGeneration();
    let session: Session;
    try {
      session = await sessionService.create({ ...args, provisional: true });
    } catch (error) {
      log.info('provisional task not opened', error);
      return null;
    }
    // The account changed while the task was being created: it belongs to the old account.
    if (!isDataOwnerIdCurrent(owner)) return null;
    current = { id: session.id, key, session, title: null, owner };
    generation += 1;
    // Register the id before the row enters the list, so grouping already sees it as unsent.
    notify();
    sessionsStore.prependCreated(session);
    return session;
  });
}

/** 输入清空 / 草稿不再适合提前建任务：删掉未发送任务。 */
export function discardProvisionalDraftTask(shouldDiscard: () => boolean = () => true): Promise<void> {
  return serial(async () => {
    // A queued empty check may run after typing / voice input has resumed.
    if (shouldDiscard()) await discardCurrent();
  });
}

/** 发送时设置与未发送任务不一致、它又删不掉：这次不能用同一个 id 新建，发送应失败并保留草稿。 */
export class ProvisionalDraftTaskBusyError extends Error {
  constructor(sessionId: string) {
    super(`unsent task ${sessionId} could not be removed before creating the task`);
    this.name = 'ProvisionalDraftTaskBusyError';
  }
}

/**
 * 发送时接管：设置与提前建的一致就转为普通任务并返回它；不一致则先删掉，返回 null，
 * 由调用方按原流程新建（同一个 id 可直接再建）。删不掉时抛 {@link ProvisionalDraftTaskBusyError}。
 */
export function takeProvisionalDraftTask(
  args: ProvisionalDraftCreateArgs,
): Promise<Session | null> {
  return serial(async () => {
    releaseForeignCurrent();
    if (!current) return null;
    if (current.id !== args.id || current.key !== provisionalDraftArgsKey(args)) {
      const blocked = current.id === args.id ? current.id : null;
      // A different id can be created regardless; the same id needs the old row gone first.
      if (!(await discardCurrent()) && blocked) throw new ProvisionalDraftTaskBusyError(blocked);
      return null;
    }
    const taken = current;
    try {
      await window.electronAPI.maker.commitProvisionalSession?.(taken.id);
    } catch (error) {
      // The first send commits it on the host as well.
      log.warn('commit provisional task failed', error);
    }
    // The account changed while committing: the task lives in the old account's database,
    // so this send cannot use it (fails like a failed create; the draft is kept).
    if (!isDataOwnerIdCurrent(taken.owner)) {
      releaseForeignCurrent();
      throw new ProvisionalDraftTaskBusyError(taken.id);
    }
    // Release editing/navigation ownership, but retain project placement while
    // the ordinary send path and any in-flight list snapshots catch up.
    current = null;
    setProvisionalDraftTaskId(null, true);
    return taken.session;
  });
}

/** 标题随输入变化（本机显示，不写库；发送后由正常的自动起名接手）。 */
export function previewProvisionalDraftTitle(title: string | null): void {
  if (!current || current.title === title) return;
  current.title = title;
  if (title) emitAutoTitlePreview(current.id, title);
  else emitAutoTitlePreviewCleared(current.id);
}

/** 草稿文档的纯文本（标题预览用）。 */
export function composerDocPlainText(doc: JSONContent | null | undefined): string {
  if (!doc) return '';
  const parts: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === 'text') parts.push(node.text ?? '');
    else if (node.type === 'hardBreak') parts.push('\n');
    else if (node.attrs && typeof (node.attrs as { label?: unknown }).label === 'string') {
      parts.push((node.attrs as { label: string }).label);
    }
    node.content?.forEach(walk);
    if (node.type === 'paragraph' || node.type === 'heading') parts.push('\n');
  };
  walk(doc);
  return parts.join('').trim();
}

/** Test-only reset. */
export function resetProvisionalDraftTaskForTest(): void {
  current = null;
  chain = Promise.resolve();
  generation = 0;
  setProvisionalDraftTaskId(null);
}
