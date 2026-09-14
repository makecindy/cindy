import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  officialProfileWriterMigrationMessage,
  shouldRefuseOfficialProfileWriterMigration,
} from '../localDb/officialProfileMigrationPolicy';

describe('shouldRefuseOfficialProfileWriterMigration', () => {
  it('unpackaged writer + 正式 profile + pending 必须拒绝', () => {
    expect(
      shouldRefuseOfficialProfileWriterMigration({
        isPackaged: false,
        officialSharedProfile: true,
        pendingCount: 1,
      }),
    ).toBe(true);
  });

  it('schema 已对齐时允许打开正式 profile', () => {
    expect(
      shouldRefuseOfficialProfileWriterMigration({
        isPackaged: false,
        officialSharedProfile: true,
        pendingCount: 0,
      }),
    ).toBe(false);
  });

  it('packaged / 沙箱 / custom 仍可迁', () => {
    expect(
      shouldRefuseOfficialProfileWriterMigration({
        isPackaged: true,
        officialSharedProfile: true,
        pendingCount: 3,
      }),
    ).toBe(false);
    expect(
      shouldRefuseOfficialProfileWriterMigration({
        isPackaged: false,
        officialSharedProfile: false,
        pendingCount: 3,
      }),
    ).toBe(false);
  });
});

describe('officialProfileWriterMigrationMessage', () => {
  it('点名待执行 migration 并指向 isolated', () => {
    const message = officialProfileWriterMigrationMessage(['0091_amazing_blur.sql']);
    expect(message).toContain('0091_amazing_blur.sql');
    expect(message).toContain('--isolated=');
  });
});

describe('official profile writer wiring', () => {
  it('index 对正式 profile 落地 XDT_OFFICIAL_SHARED_PROFILE,migrate 在备份前拒绝', () => {
    const indexSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8');
    const migrateSource = readFileSync(
      resolve(process.cwd(), 'src/main/localDb/migrate.ts'),
      'utf8',
    );
    expect(indexSource).toContain("process.env.XDT_OFFICIAL_SHARED_PROFILE = '1'");
    const refuseIdx = migrateSource.indexOf('shouldRefuseOfficialProfileWriterMigration({');
    const prepareIdx = migrateSource.indexOf('prepareBackupDiskSpace(');
    const backupIdx = migrateSource.indexOf('await backupDb(');
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(prepareIdx).toBeGreaterThan(refuseIdx);
    expect(backupIdx).toBeGreaterThan(refuseIdx);
  });
});
