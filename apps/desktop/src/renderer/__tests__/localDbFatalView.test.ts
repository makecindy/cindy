import { describe, expect, it } from 'vitest';

import {
  resolveLocalDbFatalView,
  type UpdateStatusValue,
} from '../components/error/localDbFatalView';

describe('resolveLocalDbFatalView', () => {
  it.each(['ready', 'downloading', 'idle'] as const)('schema lock failure offers DB retry regardless of update status %s (#7135)', (status) => {
    expect(resolveLocalDbFatalView(status, 'DB_SCHEMA_LOCKED')).toBe('retry-local-db');
  });
  it('ready → install-update（补丁就绪，可一键重启安装）', () => {
    expect(resolveLocalDbFatalView('ready')).toBe('install-update');
  });

  it('checking / downloading / superseding → preparing-update（等待，禁止 relaunch）', () => {
    const preparing: UpdateStatusValue[] = ['checking', 'downloading', 'superseding'];
    for (const status of preparing) {
      expect(resolveLocalDbFatalView(status)).toBe('preparing-update');
    }
  });

  it('idle / error / undefined → no-update（引导重新检查更新）', () => {
    expect(resolveLocalDbFatalView('idle')).toBe('no-update');
    expect(resolveLocalDbFatalView('error')).toBe('no-update');
    expect(resolveLocalDbFatalView(undefined)).toBe('no-update');
  });

  it('DB_INIT_FAILED → init-failed、DB_CORRUPT_NO_BACKUP → corrupt（与更新状态无关，不引导更新）', () => {
    const statuses: (UpdateStatusValue | undefined)[] = ['ready', 'checking', 'idle', 'error', undefined];
    for (const status of statuses) {
      expect(resolveLocalDbFatalView(status, 'DB_INIT_FAILED')).toBe('init-failed');
      expect(resolveLocalDbFatalView(status, 'DB_CORRUPT_NO_BACKUP')).toBe('corrupt');
    }
  });

  it('MIGRATE_FAILED / 未知码仍按更新状态映射（保持原行为）', () => {
    expect(resolveLocalDbFatalView('ready', 'MIGRATE_FAILED')).toBe('install-update');
    expect(resolveLocalDbFatalView('idle', 'MIGRATE_FAILED')).toBe('no-update');
    expect(resolveLocalDbFatalView('ready', undefined)).toBe('install-update');
  });
});
