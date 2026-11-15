import { describe, expect, it } from 'vitest';

import { shouldShowNativeFatalDialog } from '../fatalDialogPolicy';

describe('shouldShowNativeFatalDialog', () => {
  it('MIGRATE_FAILED 由 renderer 全屏恢复界面接管，不弹原生对话框', () => {
    expect(shouldShowNativeFatalDialog('MIGRATE_FAILED')).toBe(false);
  });

  it('keeps schema lease failures on the retry screen without a blocking native dialog (#7135)', () => {
    expect(shouldShowNativeFatalDialog('DB_SCHEMA_LOCKED')).toBe(false);
  });

  it('其余错误码维持原生对话框语义', () => {
    expect(shouldShowNativeFatalDialog('DB_INIT_FAILED')).toBe(true);
    expect(shouldShowNativeFatalDialog('DB_CORRUPT_NO_BACKUP')).toBe(true);
  });
});
