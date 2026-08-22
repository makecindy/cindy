import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 分离侧栏窗口对 Bot 相关 IPC 的投影，必须覆盖它真的会渲染的那些面板。
 *
 * 背景（空头支票复核 2026-08-19）：`bot-delegations` tab 在分离侧栏窗口里同样可达
 * —— `executeSidebarCommand` 的 `open-bot-delegations-tab` 会路由到当前持有侧栏的
 * 那个窗口。但 `sidebarWindowPreload.ts` 当初只补了姊妹面板 `bot-artifacts` 要的
 * `local-db:bots:artifacts`，漏了委派面板要的五条。于是 `BotDelegationsBody` 的
 * effect 里裸调 `window.electronAPI.maker.onBotDelegationChanged(...)` 直接抛
 * TypeError，被 `TabBodyErrorBoundary` 接住 —— 用户看到的是一个**空白死 tab**。
 *
 * 这是"漏配"型缺陷：两个 preload 各自维护一份手写投影，没有任何东西保证它们对同一
 * 组面板给出同一组通道。这里用源码扫描把集合钉死 —— 起进程才能测的东西，至少让
 * "有没有这一条"变成编译期之外的确定性断言。
 *
 * 只钉 Bot 相关通道，不是要求两个 preload 全量一致（它们本来就该不一致：分离窗口
 * 刻意不含 maker 会话 IPC、登录、设置、更新等）。
 */

const preloadDir = path.resolve(__dirname, '..');
const mainPreload = readFileSync(path.join(preloadDir, 'preload.ts'), 'utf8');
const sidebarPreload = readFileSync(path.join(preloadDir, 'sidebarWindowPreload.ts'), 'utf8');

/** `bot-delegations` 面板在渲染期真正会碰到的通道（逐条对应 BotDelegationsBody 的调用点）。 */
const DELEGATION_PANEL_CHANNELS = [
  'maker:bot-delegations:list',
  'maker:bot-delegation:cancel',
  'maker:bot-delegation:changed',
  'maker:bot-delivery:retry',
  'maker:bot-delivery:changed',
  'maker:open-session-in-new-window',
] as const;

/** `bot-artifacts` 面板要的（本来就有，一并钉住防回退）。 */
const ARTIFACT_PANEL_CHANNELS = ['local-db:bots:artifacts'] as const;

describe('分离侧栏窗口的 Bot 通道投影', () => {
  it('委派面板要的通道，两个 preload 都得有', () => {
    for (const channel of DELEGATION_PANEL_CHANNELS) {
      expect(mainPreload, `主窗口 preload 应有 ${channel}`).toContain(`'${channel}'`);
      expect(
        sidebarPreload,
        `分离侧栏窗口 preload 缺少 ${channel} —— bot-delegations tab 在该窗口会变成空白死 tab`,
      ).toContain(`'${channel}'`);
    }
  });

  it('交付物面板要的通道也在（防回退）', () => {
    for (const channel of ARTIFACT_PANEL_CHANNELS) {
      expect(mainPreload).toContain(`'${channel}'`);
      expect(sidebarPreload).toContain(`'${channel}'`);
    }
  });

  it('推送类通道在两侧都带 ownerStamp 第二参，否则数据主人守卫会失效', () => {
    // 渲染层统一用 isDataOwnerPushCurrent(ownerStamp) 丢弃旧账号的残留推送；
    // 分离窗口若用单参 onPayload 接推送，ownerStamp 恒 undefined，守卫形同虚设。
    for (const channel of ['maker:bot-delegation:changed', 'maker:bot-delivery:changed']) {
      const line = sidebarPreload
        .split('\n')
        .find((row) => row.includes(`'${channel}'`));
      expect(line, `${channel} 应出现在分离侧栏 preload 中`).toBeDefined();
      expect(
        line,
        `${channel} 必须走 onPayloadWithMetadata 才能把 ownerStamp 传给渲染层`,
      ).toContain('onPayloadWithMetadata');
    }
  });

  it('分离窗口不因此获得伙伴身份/生命周期的写能力', () => {
    // 边界复核：补的是委派运行态，不是 Bot Profile / Session 生命周期。
    for (const forbidden of [
      'local-db:bots:update',
      'local-db:bots:create',
      'maker:bot-lifecycle:action',
      'maker:bots:generate-persona',
    ]) {
      expect(
        sidebarPreload,
        `分离侧栏窗口不应暴露 ${forbidden}`,
      ).not.toContain(`'${forbidden}'`);
    }
  });
});
