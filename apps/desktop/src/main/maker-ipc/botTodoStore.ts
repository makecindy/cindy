import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  applyTodoPatch,
  emptyTodoState,
  TodoError,
  normalizeTodoKey,
  todoVisible,
  validateTodoDeadline,
  validateTodoTimestamp,
  type TodoPatch,
  type TodoState,
  type TeammateTodo,
} from '@cindy/maker-shared/teammate-todo';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import type { WorkbenchTaskJudgment } from '../../shared/botWorkbench.js';
import { parseWorkbenchTaskId } from '../../shared/botWorkbench.js';

function validText(value: unknown, max: number, required = false): boolean {
  return typeof value === 'string' && value.length <= max && (!required || !!value.trim());
}

function validTimestamp(value: unknown): boolean {
  try {
    validateTodoTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

export interface TodoIngestInput {
  source: string;
  sequence: number;
  patch?: TodoPatch;
  skip?: 'duplicate' | 'suppressed' | 'outside-scope' | 'no-action';
}
export interface TodoIngestResult {
  duplicate: boolean;
  suppressed?: boolean;
  todo?: TeammateTodo | null;
}
export interface BotTodoStore {
  read(): Promise<TodoState>;
  patch(patch: TodoPatch): Promise<TeammateTodo>;
  ingest(input: TodoIngestInput): Promise<TodoIngestResult>;
  prepareAction(
    id: string,
    revision: number,
    requestId: string,
  ): Promise<{ todo: TeammateTodo; dispatch: boolean }>;
  settleAction(
    id: string,
    requestId: string,
    result: { ok: boolean; uncertain?: boolean; error?: string },
  ): Promise<TeammateTodo | null>;
}
/** A separate versioned affair store preserves the old task/project file unchanged. */
export function createBotTodoStore(
  file: string,
  legacy: () => Promise<Record<string, WorkbenchTaskJudgment>>,
  assertCurrent = () => {},
): BotTodoStore {
  const fingerprint = (j: WorkbenchTaskJudgment) =>
    createHash('sha256').update(JSON.stringify(j)).digest('hex');
  const legacyItem = (legacyId: string, j: WorkbenchTaskJudgment): TeammateTodo | null => {
    const ref = parseWorkbenchTaskId(legacyId);
    if (!ref || !['github', 'idea'].includes(ref.kind)) return null;
    const at = j.updatedAt;
    return {
      id: 'todo:legacy-' + createHash('sha256').update(legacyId).digest('hex').slice(0, 24),
      revision: 1,
      key: 'legacy:' + legacyId,
      origin: j.verdict === 'idea' ? 'discovered' : 'assigned',
      title: j.title,
      progress: j.next ?? '',
      outcome: j.title,
      value: '',
      next:
        j.verdict === 'done'
          ? null
          : { label: 'Continue', instruction: j.next || j.title, kind: 'advance' },
      sources: [
        {
          kind: ref.kind === 'github' ? 'github' : 'conversation',
          id: legacyId,
          label: j.title,
          ...(j.ref && /^https:\/\//.test(j.ref) ? { ref: j.ref } : {}),
          project: j.project,
        },
      ],
      associations:
        ref.kind === 'github' && ref.type === 'pr'
          ? [{ kind: 'pr', id: legacyId, label: j.title }]
          : [],
      status: j.verdict === 'done' ? 'done' : 'open',
      createdAt: at,
      updatedAt: at,
      sourceDeadline: null,
      deadlineCandidate: null,
      suggestedDate: null,
      decision: null,
      history:
        j.verdict === 'done'
          ? [
              {
                summary: j.next || 'Legacy completion evidence was not recorded',
                ...(j.ref ? { ref: j.ref } : {}),
                at,
              },
            ]
          : [],
      action: null,
      legacyId,
      legacyFingerprint: fingerprint(j),
      legacyVerdict: j.verdict,
    };
  };
  async function read(): Promise<TodoState> {
    assertCurrent();
    let state: TodoState;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as TodoState;
      if (
        !raw ||
        typeof raw !== 'object' ||
        raw.version !== 1 ||
        !Array.isArray(raw.items) ||
        !raw.cursors ||
        !raw.receipts ||
        raw.items.some(
          (t) =>
            !t ||
            typeof t.id !== 'string' ||
            !Number.isInteger(t.revision) ||
            !Array.isArray(t.sources) ||
            !Array.isArray(t.history) ||
            !Array.isArray(t.associations) ||
            !['open', 'done'].includes(t.status),
        )
      )
        throw new TodoError('CORRUPT_STORE');
      if (
        typeof raw.cursors !== 'object' ||
        typeof raw.receipts !== 'object' ||
        Array.isArray(raw.cursors) ||
        Array.isArray(raw.receipts) ||
        Object.entries(raw.cursors).some(
          ([key, value]) => !key || !Number.isSafeInteger(value) || value < 0,
        ) ||
        Object.values(raw.receipts).some((value) => typeof value !== 'string')
      )
        throw new TodoError('CORRUPT_STORE');
      const ids = new Set<string>(),
        keys = new Set<string>();
      for (const t of raw.items) {
        if (ids.has(t.id) || keys.has(t.key)) throw new TodoError('CORRUPT_STORE');
        ids.add(t.id);
        keys.add(t.key);
        if (
          t.sources.some(
            (s) =>
              !s ||
              !validText(s.id, 512, true) ||
              !validText(s.label, 300, true) ||
              !['conversation', 'mail', 'feishu', 'github', 'community', 'task'].includes(s.kind) ||
              (s.ref !== undefined &&
                (!validText(s.ref, 2000) || !/^https:\/\/[^\s]+$/.test(s.ref))) ||
              (s.project !== undefined && !validText(s.project, 4096, true)) ||
              (s.version !== undefined && (!Number.isSafeInteger(s.version) || s.version < 0)) ||
              (s.observedAt !== undefined && !validTimestamp(s.observedAt)),
          ) ||
          t.associations.some(
            (a) =>
              !a ||
              !['task', 'pr'].includes(a.kind) ||
              !validText(a.id, 512, true) ||
              !validText(a.label, 300, true),
          ) ||
          t.history.some(
            (h) =>
              !h ||
              !validText(h.summary, 4000, true) ||
              !validTimestamp(h.at) ||
              (h.ref !== undefined && !validText(h.ref, 2000)),
          ) ||
          (t.next !== null &&
            (!t.next ||
              !validText(t.next.label, 100, true) ||
              !validText(t.next.instruction, 4000, true) ||
              !['advance', 'view', 'decide'].includes(t.next.kind))) ||
          (t.decision !== null &&
            (!t.decision ||
              !['deleted', 'muted', 'later'].includes(t.decision.kind) ||
              (t.decision.until !== undefined && !validTimestamp(t.decision.until)) ||
              (t.decision.kind === 'later' && !t.decision.until))) ||
          (t.action !== null &&
            (!t.action ||
              !validText(t.action.requestId, 80, true) ||
              !Number.isSafeInteger(t.action.revision) ||
              t.action.revision < 1 ||
              (t.action.error !== undefined && !validText(t.action.error, 1000)) ||
              !['received', 'accepted', 'failed', 'unknown'].includes(t.action.state)))
        )
          throw new TodoError('CORRUPT_STORE');
        if (
          typeof t.id !== 'string' ||
          !t.id ||
          t.id.length > 512 ||
          typeof t.key !== 'string' ||
          !t.key ||
          t.key.length > 512 ||
          !Number.isSafeInteger(t.revision) ||
          t.revision < 1 ||
          typeof t.title !== 'string' ||
          !t.title.trim() ||
          t.title.length > 300 ||
          typeof t.outcome !== 'string' ||
          !t.outcome.trim() ||
          t.outcome.length > 4000 ||
          typeof t.progress !== 'string' ||
          t.progress.length > 4000 ||
          typeof t.value !== 'string' ||
          t.value.length > 4000 ||
          !['assigned', 'discovered'].includes(t.origin) ||
          !validTimestamp(t.createdAt) ||
          !validTimestamp(t.updatedAt)
        )
          throw new TodoError('CORRUPT_STORE');
        try {
          validateTodoDeadline(t.sourceDeadline);
          if (t.suggestedDate !== null) {
            if (!validText(t.suggestedDate, 10)) throw new TodoError('CORRUPT_STORE');
            if (t.suggestedDate)
              validateTodoDeadline({ kind: 'date', date: t.suggestedDate, timeZone: 'UTC' });
          }
          if (t.deadlineOverride !== undefined) {
            if (
              !t.deadlineOverride ||
              typeof t.deadlineOverride !== 'object' ||
              Array.isArray(t.deadlineOverride)
            )
              throw new TodoError('CORRUPT_STORE');
            validateTodoDeadline(t.deadlineOverride.value);
          }
          if (t.deadlineCandidate !== null) {
            if (
              !t.deadlineCandidate ||
              typeof t.deadlineCandidate !== 'object' ||
              Array.isArray(t.deadlineCandidate)
            )
              throw new TodoError('CORRUPT_STORE');
            validateTodoDeadline(t.deadlineCandidate.value);
            if (
              typeof t.deadlineCandidate.reason !== 'string' ||
              !t.deadlineCandidate.reason.trim() ||
              t.deadlineCandidate.reason.length > 2000
            )
              throw new TodoError('CORRUPT_STORE');
          }
        } catch {
          throw new TodoError('CORRUPT_STORE');
        }
      }
      state = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = emptyTodoState();
    }
    // Reconcile legacy writes on every read, not just before the first new-format save.
    // Only fields the legacy tool can represent are mapped. Decisions, dates, outcome and links survive.
    for (const [legacyId, j] of Object.entries(await legacy())) {
      const imported = legacyItem(legacyId, j);
      if (!imported) continue;
      const old = state.items.find((t) => t.legacyId === legacyId);
      if (!old) {
        state.items.push(imported);
        continue;
      }
      if (old.legacyFingerprint === imported.legacyFingerprint) continue;
      old.title = imported.title;
      old.progress = imported.progress;
      old.origin = imported.origin;
      old.sources = old.sources.map((source) =>
        source.id === legacyId
          ? {
              ...source,
              label: j.title,
              ...(imported.sources[0].ref ? { ref: imported.sources[0].ref } : {}),
            }
          : source,
      );
      const verdictChanged = old.legacyVerdict !== j.verdict;
      if (old.next?.label === 'Continue' || (verdictChanged && !old.next)) old.next = imported.next;
      if (verdictChanged) {
        if (old.status !== imported.status && imported.status === 'done')
          old.history.push(...imported.history);
        old.status = imported.status;
      }
      old.legacyVerdict = j.verdict;
      old.legacyFingerprint = imported.legacyFingerprint;
      old.revision++;
      old.updatedAt = [old.updatedAt, j.updatedAt].sort().at(-1)!;
    }
    assertCurrent();
    return state;
  }
  async function mutate<T>(fn: (state: TodoState) => T): Promise<T> {
    assertCurrent();
    await fs.mkdir(path.dirname(file), { recursive: true });
    return withCrossProcessLock(
      file + '.lock',
      { label: 'teammate-todo', waitMs: 12000 },
      async (held) => {
        if (!held.held) throw new TodoError('BUSY');
        assertCurrent();
        const state = await read(),
          result = fn(state);
        assertCurrent();
        const temp = file + '.' + randomUUID() + '.tmp';
        try {
          await fs.writeFile(temp, JSON.stringify(state) + '\n', { encoding: 'utf8', mode: 0o600 });
          assertCurrent();
          await fs.rename(temp, file);
        } finally {
          await fs.rm(temp, { force: true }).catch(() => {});
        }
        assertCurrent();
        return result;
      },
    );
  }
  return {
    read,
    patch: (patch: TodoPatch) => mutate((s) => applyTodoPatch(s, patch, 'todo:' + randomUUID())),
    ingest: (params: {
      source: string;
      sequence: number;
      patch?: TodoPatch;
      skip?: 'duplicate' | 'suppressed' | 'outside-scope' | 'no-action';
    }) =>
      mutate((s) => {
        if (
          !/^[A-Za-z0-9:_./-]{1,512}$/.test(params.source) ||
          ['__proto__', 'prototype', 'constructor'].includes(params.source) ||
          !Number.isSafeInteger(params.sequence) ||
          params.sequence < 0
        )
          throw new TodoError('INVALID_EVENT');
        const receipt = params.source + ':' + params.sequence;
        if (
          params.sequence <=
            (Object.hasOwn(s.cursors, params.source) ? s.cursors[params.source] : -1) ||
          Object.hasOwn(s.receipts, receipt)
        )
          return { duplicate: true };
        if (!params.patch && !params.skip) throw new TodoError('INVALID_EVENT');
        const key =
          params.patch?.key === undefined ? undefined : normalizeTodoKey(params.patch.key);
        const existing = s.items.find((t) => t.key === key || t.id === params.patch?.id);
        const suppressed = (!!existing && !todoVisible(existing)) || existing?.status === 'done';
        const saved =
          params.patch && !suppressed
            ? applyTodoPatch(s, params.patch, 'todo:' + randomUUID())
            : null;
        s.cursors[params.source] = params.sequence;
        // The monotonic cursor already proves older receipts; retain only the latest per stream.
        for (const key of Object.keys(s.receipts)) {
          const split = key.lastIndexOf(':');
          if (key.slice(0, split) === params.source) delete s.receipts[key];
        }
        s.receipts[receipt] = saved?.id ?? params.skip ?? 'suppressed';
        return { duplicate: false, suppressed, todo: saved };
      }),
    prepareAction: (id: string, revision: number, requestId: string) =>
      mutate((s) => {
        const t = s.items.find((t) => t.id === id);
        if (!t) throw new TodoError('NOT_FOUND');
        if (t.action && (t.action.requestId === requestId || t.action.state !== 'failed'))
          return { todo: t, dispatch: false };
        if (t.revision !== revision) throw new TodoError('CONFLICT');
        if (t.decision?.kind === 'later' && todoVisible(t)) t.decision = null;
        if (t.status !== 'open' || t.decision || !t.next || t.next.kind === 'view')
          throw new TodoError('NO_NEXT_ACTION');
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new TodoError('INVALID_REQUEST_ID');
        t.action = { requestId, revision: t.revision, state: 'received' };
        return { todo: structuredClone(t), dispatch: true };
      }),
    settleAction: (
      id: string,
      requestId: string,
      result: { ok: boolean; uncertain?: boolean; error?: string },
    ) =>
      mutate((s) => {
        const t = s.items.find((t) => t.id === id);
        if (!t?.action || t.action.requestId !== requestId || t.action.state !== 'received')
          return null;
        t.action = {
          ...t.action,
          state: result.ok ? 'accepted' : result.uncertain ? 'unknown' : 'failed',
          ...(result.error ? { error: result.error.slice(0, 500) } : {}),
        };
        return t;
      }),
  };
}
