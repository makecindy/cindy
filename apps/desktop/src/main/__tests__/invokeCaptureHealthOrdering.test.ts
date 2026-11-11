/**
 * invokeCaptureHealthOrdering.test.ts —— 锁住 device-link invoke-capture 自检的时机。
 *
 * 真机实测发现:`assertCaptureHealthy()` 原本在 bootstrap 线性段(initDeviceLinkService 之后)
 * 调用,而 `maker:create-session` / `maker:send` 由 splash 后的 registerMakerIpcsAfterSplash
 * 延迟注册 —— 自检跑在它们注册之前,误报「critical channels missing」。修复:把自检挪到
 * registerMakerIpcsAfterSplash 内 registerMakerCoreIpc 之后。本测试用源不变式锁住该顺序,
 * 防回退(整段 bootstrap 启 Electron 才能跑,故用静态断言而非运行时)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');

describe('invoke-capture health check ordering', () => {
  it('只调用一次 assertCaptureHealthy(移除了线性段的早调用)', () => {
    const calls = bootstrapSource.match(/assertCaptureHealthy\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('assertCaptureHealthy 在 registerMakerCoreIpc 之后(maker:create-session/send 注册后才自检)', () => {
    const makerReg = bootstrapSource.indexOf('registerMakerCoreIpc(');
    const healthCheck = bootstrapSource.indexOf('assertCaptureHealthy()');
    expect(makerReg).toBeGreaterThanOrEqual(0);
    expect(healthCheck).toBeGreaterThan(makerReg);
  });

  it('自检与 makerIpcsRegistered 同段(splash 后延迟注册块内)', () => {
    const healthCheck = bootstrapSource.indexOf('assertCaptureHealthy()');
    // Explicit Host mode has its own early return; inspect the desktop commit
    // immediately preceding the health check, not the Host-only branch.
    const flag = bootstrapSource.lastIndexOf('makerIpcsRegistered = true', healthCheck);
    expect(flag).toBeGreaterThanOrEqual(0);
    // 自检紧随 makerIpcsRegistered=true 之后(同一 try 块末尾)。
    expect(healthCheck).toBeGreaterThan(flag);
    expect(healthCheck - flag).toBeLessThan(600); // 之间只隔一段注释,不应跨越大段代码
  });
});
