/**
 * Help-assistant 用户反馈草稿 (Phase 1):本地 JSON 存储,无远程。
 *
 * 触发场景:用户对 help-assistant 的某条回答不满意 → 点 👎 反馈 →
 * 编辑标题 / 详细说明 → 保存 → 这里把 draft 落到
 * `<userData>/help-feedback-drafts.json` 里,生成 id 返回给 renderer。
 * Renderer 把 id 挂到对应 message 上,渲染"已记录反馈"指示。
 *
 * Phase 2 会在这套 draft 之上加一个 "submit to GitHub" 动作 ——
 * 因此 schema 设计成"加一个 submittedIssueUrl?: string 字段就能扩"的形态,
 * 不要破坏现有 draft 文件。
 *
 * 并发控制:`HELP_FEEDBACK_CREATE` 的 read-modify-write 用进程内 promise 链
 * 串行化,避免并发点击产生交叉写丢数据。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { createId } from '@paralleldrive/cuid2';

import { MAKER_INVOKE } from './channels.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import type {
  HelpFeedbackDraft,
  HelpFeedbackDraftInput,
  HelpLocale,
} from '../../shared/helpTypes.js';

const log = createLogger('help-feedback');

const VALID_LOCALES: ReadonlySet<HelpLocale> = new Set<HelpLocale>(['zh-CN', 'zh-TW', 'en', 'ja', 'ko']);

function draftFilePath(): string {
  return path.join(app.getPath('userData'), 'help-feedback-drafts.json');
}

function isDraftRecord(value: unknown): value is HelpFeedbackDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as HelpFeedbackDraft;
  return (
    typeof d.id === 'string' &&
    typeof d.question === 'string' &&
    typeof d.answer === 'string' &&
    typeof d.title === 'string' &&
    typeof d.body === 'string' &&
    typeof d.locale === 'string' &&
    typeof d.createdAt === 'string'
  );
}

async function readAll(): Promise<HelpFeedbackDraft[]> {
  const file = draftFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // I/O failure (perm denied, etc.) — log and return empty so the caller
    // doesn't crash. We do NOT proceed to write here, which would otherwise
    // silently overwrite a file we couldn't read.
    log.warn('readAll: file read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // Top-level shape is wrong. Treat as corrupted: back up + start fresh.
      await quarantineCorrupted(file, raw, 'not-an-array');
      return [];
    }
    return parsed.filter(isDraftRecord);
  } catch (err) {
    // JSON parse error — file is corrupted. Back it up with a timestamped
    // suffix so the user (or a recovery script) can inspect it later;
    // return empty so the next write produces a clean file rather than
    // silently overwriting partially-readable history.
    await quarantineCorrupted(file, raw, err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function quarantineCorrupted(
  file: string,
  rawContent: string,
  reason: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.corrupted-${stamp}`;
  try {
    // Write a copy first (safer than `rename` — keeps the original until we
    // know the copy succeeded). The original file gets overwritten by the
    // caller's next writeAllAtomic.
    await fs.writeFile(backup, rawContent, 'utf-8');
    log.warn('readAll: corrupted draft file quarantined', {
      backup,
      reason,
    });
  } catch (err) {
    log.warn('readAll: quarantine write failed (proceeding with empty list anyway)', {
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function writeAllAtomic(drafts: HelpFeedbackDraft[]): Promise<void> {
  const file = draftFilePath();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(drafts, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

// 串行化所有写操作 — read-modify-write 不能并发执行,否则会覆盖丢数据。
let writeLock: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeLock.then(fn);
  // 让链条在错误时也能继续 — 当前任务的错误返回给 caller,但下一个任务从干净起点开始
  writeLock = next.catch(() => undefined);
  return next;
}

function validateInput(raw: unknown): HelpFeedbackDraftInput {
  if (!raw || typeof raw !== 'object') {
    throwIpcError('INVALID_PARAMS', 'feedback input required');
  }
  const i = raw as Partial<HelpFeedbackDraftInput>;
  if (typeof i.question !== 'string' || i.question.trim().length === 0) {
    throwIpcError('INVALID_PARAMS', 'question required (non-empty string)');
  }
  if (typeof i.answer !== 'string') {
    throwIpcError('INVALID_PARAMS', 'answer required (string, may be empty)');
  }
  if (typeof i.title !== 'string' || i.title.trim().length === 0) {
    throwIpcError('INVALID_PARAMS', 'title required (non-empty string)');
  }
  if (typeof i.body !== 'string') {
    throwIpcError('INVALID_PARAMS', 'body required (string)');
  }
  if (typeof i.locale !== 'string' || !VALID_LOCALES.has(i.locale as HelpLocale)) {
    throwIpcError('INVALID_PARAMS', `invalid locale (got ${String(i.locale)})`);
  }
  return {
    question: i.question,
    answer: i.answer,
    title: i.title,
    body: i.body,
    locale: i.locale as HelpLocale,
  };
}

export function registerHelpFeedbackIpc(): void {
  ipcMain.handle(MAKER_INVOKE.HELP_FEEDBACK_CREATE, async (_e, raw: unknown) => {
    const input = validateInput(raw);
    return withWriteLock(async () => {
      const existing = await readAll();
      const draft: HelpFeedbackDraft = {
        ...input,
        id: createId(),
        createdAt: new Date().toISOString(),
      };
      await writeAllAtomic([...existing, draft]);
      log.info('feedback draft saved', {
        id: draft.id,
        locale: draft.locale,
        titleLen: draft.title.length,
        bodyLen: draft.body.length,
      });
      return draft;
    });
  });
}
