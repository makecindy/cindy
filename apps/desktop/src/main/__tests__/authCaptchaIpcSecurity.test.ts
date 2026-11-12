import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * bootstrap-electron 依赖完整 Electron 启动环境，Node 单测不能直接 import。
 * 这里锁住 CAPTCHA URL IPC 的授权顺序；统一 guard 自身的 senderFrame、顶层
 * frame、已登记 Cindy 窗口与 URL 判据由 security/trustedAppRenderer.test 覆盖。
 */
describe('desktop captcha challenge URL IPC boundary', () => {
  const source = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');

  it('在读取认证端点前拒绝非可信 sender', () => {
    const start = source.indexOf("ipcMain.handle('auth:get-captcha-challenge-url'");
    const end = source.indexOf("ipcMain.handle('auth:logout'", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const handler = source.slice(start, end);
    const guard = handler.indexOf('assertTrustedAppRendererEvent(event);');
    const readUrl = handler.indexOf('authManager.getLoginCaptchaChallengeUrl()');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(readUrl).toBeGreaterThan(guard);
  });
});
