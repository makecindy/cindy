import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * isolated 身份落在正式 profile 上必须在换目录 / 换 deviceId 之前拒绝启动。
 * 2026-08-16：cindy-pi-live-model-catalog 自称 isolated、目录仍是正式 Cindy，
 * DEVICE_MISMATCH 后清掉正式版 refresh token。
 */
describe('isolated-on-production-profile startup refuse', () => {
  const indexSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('main process fail-closes before applying userData or isolated deviceId', () => {
    const refuseIdx = indexSource.indexOf('if (devFlags.isolatedOnProductionProfile)');
    const setPathIdx = indexSource.indexOf("app.setPath('userData', devFlags.userDataDirOverride)");
    const deviceIdx = indexSource.indexOf('if (devFlags.needsIsolatedDeviceId)');
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(setPathIdx).toBeGreaterThan(refuseIdx);
    expect(deviceIdx).toBeGreaterThan(refuseIdx);
    expect(indexSource).toContain("appDataDir: app.getPath('appData')");
    expect(indexSource).toContain("isolated: devFlags.profileKind === 'isolated-sandbox'");
    expect(indexSource).toContain('isolationIntent: devFlags.isolated');
    expect(indexSource).toContain('profileKind: devFlags.profileKind');
  });
});
