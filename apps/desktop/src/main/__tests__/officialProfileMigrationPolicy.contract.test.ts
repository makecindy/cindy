// Guard tier: engineering-conventions section 3.2. Existing cross-file
// credential, permission, protocol, race, and design contracts are isolated
// from runtime unit tests. No new input or assertion is introduced here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
