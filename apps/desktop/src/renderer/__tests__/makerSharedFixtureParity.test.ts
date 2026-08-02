import { describe, expect, it } from 'vitest';
import {
  buildMobileDirectoryEntries,
  buildMobileScheduleInput,
  createMobileScheduleDraft,
  normalizeRemoteDirectoryListResult,
  normalizeRemotePathStatResults,
} from '@cindy/maker-shared';
import { SHARED_REMOTE_CONTROL_FIXTURE } from '@cindy/maker-shared/fixtures';
import type { RemoteSchedule } from '@cindy/maker-shared/schedule-types';

import { categorizeByFilename, categorizeFile, extractExt } from '@/lib/fileTypes';
import {
  buildScheduleInput,
  type ScheduleFormState,
} from '@/features/scheduler/lib/scheduleFormLogic';

describe('maker-shared desktop parity fixture', () => {
  it('keeps bound schedule update semantics aligned with the desktop form logic', () => {
    const schedule = SHARED_REMOTE_CONTROL_FIXTURE.rawSchedulePayloads.boundSessionSchedule;
    const sharedInput = buildMobileScheduleInput(createMobileScheduleDraft(schedule));
    const desktopInput = buildScheduleInput(toDesktopScheduleFormState(schedule));

    for (const input of [sharedInput, desktopInput]) {
      expect(input).toMatchObject({
        targetSessionId: 'session-primary',
        persistentSession: false,
        useWorktree: false,
      });
      expect(hasOwn(input, 'workingDir')).toBe(false);
      expect(hasOwn(input, 'model')).toBe(true);
      expect(hasOwn(input, 'effort')).toBe(true);
      expect(input.model).toBeUndefined();
      expect(input.effort).toBeUndefined();
      expect(hasOwn(input, 'fastMode')).toBe(false);
    }
  });

  it('keeps shared file preview categories compatible with desktop attachment categories', () => {
    const listDir = normalizeRemoteDirectoryListResult(SHARED_REMOTE_CONTROL_FIXTURE.rawFilePayloads.listDir);
    const stats = normalizeRemotePathStatResults(SHARED_REMOTE_CONTROL_FIXTURE.rawFilePayloads.stats);
    const rows = buildMobileDirectoryEntries(listDir.entries, stats).filter((row) => row.kind === 'file');

    expect(rows.map((row) => [
      row.name,
      row.previewKind,
      desktopAttachmentCategory(row.name),
    ])).toEqual([
      ['demo.mp4', 'binary', 'file'],
      ['README.md', 'text', 'text'],
      ['sheet.xlsx', 'office', 'office'],
      ['spec.pdf', 'pdf', 'pdf'],
      ['zeta.log', 'text', 'text'],
    ]);
  });
});

function toDesktopScheduleFormState(schedule: RemoteSchedule): ScheduleFormState {
  return {
    name: schedule.name,
    prompt: schedule.prompt ?? '',
    cronExpr: schedule.cronExpr ?? '0 9 * * *',
    timezone: schedule.timezone ?? 'Asia/Shanghai',
    recurring: schedule.recurring ?? true,
    manual: !!schedule.manual,
    agentKind: schedule.agentKind ?? 'claude-code',
    model: schedule.model ?? '',
    // RemoteSchedule 没有 provider 概念,parity fixture 取桌面空默认(provider 同 model 成对)
    providerId: '',
    effort: asDesktopEffort(schedule.effort),
    fastMode: !!schedule.fastMode,
    workspaceKind: schedule.workspaceKind ?? (schedule.workingDir ? 'project' : 'dialogue'),
    workingDir: schedule.workingDir ?? '',
    useWorktree: !!schedule.useWorktree,
    targetSessionId: schedule.targetSessionId ?? '',
    persistentSession: !!schedule.persistentSession,
    // 与共享侧 createMobileScheduleDraft 同口径(scheduleForm.ts),保证 parity 取值一致
    silentWhenIdle: !!schedule.silentWhenIdle,
    // RemoteSchedule 尚未透出 preRunHook,parity fixture 取桌面关闭默认
    preRunHookEnabled: false,
    preRunHookCommand: '',
    preRunHookTimeoutSec: '',
    notifyDesktop: schedule.notify?.desktop !== false,
    notifyFeishu: schedule.notify?.feishu === true,
    ...(schedule.notify?.wecomGroup === true ? { notifyWecomGroup: true } : {}),
  };
}

function asDesktopEffort(value: string | undefined): ScheduleFormState['effort'] {
  if (
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  ) {
    return value;
  }
  return '';
}

function desktopAttachmentCategory(name: string): ReturnType<typeof categorizeFile> {
  const ext = extractExt(name);
  return ext ? categorizeFile(ext) : categorizeByFilename(name);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
