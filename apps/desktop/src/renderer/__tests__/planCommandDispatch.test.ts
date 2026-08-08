/**
 * planCommandDispatch.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: /plan desktop slash command (#1867)
 *
 * `/plan` 是 desktop 命令（main 注册 + renderer 落实 UI）:输入 `/plan` 回车或从
 * `/` palette 选择后,dispatch 走 executeDesktopCommand → main registry execute →
 * DESKTOP_COMMAND_TRIGGERED 回流 → CCAgentSessionView 订阅里按 sessionId toggle
 * 计划模式(草稿态由 NewMakerDraftRoute 在发送路径拦截处理,见 draft 用例)。
 * 本文件是源码不变式测试(与 issueCommandAttachments.test.ts 同款),
 * 防以下契约被后续改动回退:
 *   1) main:plan 命令已注册,且 draft(无 sessionId)只回发起窗口、不 broadcast;
 *   2) CCAgentSessionView:plan 分支要求 sessionId,并保留 effect 顶部对
 *      payload.sessionId !== sessionId 的早退(避免其它窗口的会话命令误切当前会话);
 *   3) CCAgentSessionView:capabilities 未加载(sessionCaps == null)时不吞命令;
 *      已加载但 planMode 缺失/不支持时忽略;
 *   4) CCAgentSessionView:支持时按当前状态 toggle(setPlanMode(nextEnabled),
 *      nextEnabled 由 getSnapshot 取「当下」planModeEnabled 计算,监听器不依赖闭包旧值;
 *      且失败 rejection 被显式吞掉(不升级为未捕获的 Promise rejection);
 *   5) 草稿路由:handleSend 在创建会话前拦截纯文本 /plan,切换草稿 planMode;
 *      命令列表每次 forceReload(缓存 key 感知不到同一上下文里 skill 增删),SSH 远程
 *      skipAgentSkills,device-link 远程草稿按 effectiveDeviceLinkDeviceId 从被控端读
 *      skill(与 ChatInput palette 语义一致);命中同名 agent skill 时放行发送,
 *      仅确认归属 desktop 命令后才 toast「远程草稿不可用」/ toggle 草稿 planMode。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const builtinsSource = readFileSync(
  // __dirname = src/renderer/__tests__ → 上两级到 src,再进 main/commands
  resolve(__dirname, '..', '..', 'main', 'commands', 'builtins.ts'),
  'utf8',
);

const sessionViewSource = readFileSync(
  resolve(
    __dirname,
    '..',
    'features',
    'cc-agent',
    'CCAgentSessionView.tsx',
  ),
  'utf8',
);

function planBranchSource(): string {
  const idx = sessionViewSource.indexOf("payload.command === 'plan'");
  if (idx < 0) throw new Error('plan branch missing');
  // 动态定位到 .catch( 收尾,不依赖固定长度 slice(注释加长会推远断言,Codex P1 / Copilot)
  const catchIdx = sessionViewSource.indexOf('.catch(', idx);
  if (catchIdx < 0) throw new Error('.catch( missing after plan branch');
  return sessionViewSource.slice(idx, catchIdx + 120);
}

describe('/plan slash command contract', () => {
  it('registers a desktop `plan` command in main', () => {
    const planBlock = builtinsSource.match(/registry\.register\(\{[\s\S]*?name: 'plan',[\s\S]*?\}\);/);
    expect(planBlock).not.toBeNull();
    expect(planBlock![0]).toContain('description:');
  });

  it('broadcasts plan to all windows only when a sessionId is present; drafts go to the sender window only', () => {
    const planBlock = builtinsSource.match(/registry\.register\(\{[\s\S]*?name: 'plan',[\s\S]*?\}\);/);
    const block = planBlock![0];
    // draft(无 sessionId)分支必须存在,且不调用 broadcastDesktopCommand
    expect(block).toMatch(/if \(ctx\.sessionId\)/);
    expect(block).toContain('broadcastDesktopCommand(buildPayload(\'plan\', ctx))');
    expect(block).toContain('sendDesktopCommandToSender(ctx, buildPayload(\'plan\', ctx))');
  });

  it('does not toggle plan mode when the payload carries no sessionId', () => {
    const branch = planBranchSource();
    // guard 基于 payload.sessionId:无 sessionId 的命令(draft 分支/回退广播)不切当前会话
    expect(branch).toMatch(/if \(payload\.sessionId && /);
  });

  it('keeps the cross-window guard: session commands are dropped when sessionId mismatches', () => {
    // effect 顶部已有 `if (payload.sessionId && payload.sessionId !== sessionId) return;`
    // 防止其它窗口广播的会话命令误切当前会话 —— 回归测试必须锁住它,否则移除 guard
    // 后仍会通过但引入跨窗口误切换。
    const guardIdx = sessionViewSource.indexOf('payload.sessionId && payload.sessionId !== sessionId');
    const planIdx = sessionViewSource.indexOf("payload.command === 'plan'");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(planIdx);
  });

  it('runs /plan when capabilities are still loading (sessionCaps == null); ignores when loaded but planMode missing/unsupported', () => {
    const branch = planBranchSource();
    // 整个 capabilities 未加载(null,冷启动/远程拉取慢) → 不吞命令;
    // capabilities 已加载但 planMode 缺失(device-link 老被控端,undefined = 不支持)
    // 或 supported === false → 忽略。
    expect(branch).toContain('(sessionCaps == null || sessionCaps.planMode?.supported === true)');
  });

  it('toggles plan mode based on the current state when supported', () => {
    const branch = planBranchSource();
    // next 从 getSnapshot 取「当下」planModeEnabled(监听器不依赖闭包旧值,Copilot)
    expect(branch).toContain('setPlanMode(nextEnabled)');
    expect(branch).toContain('getSnapshot(payload.sessionId).planModeEnabled');
    // setPlanMode 持久化失败会 reject —— 必须显式 .catch 吞掉,避免未捕获 rejection
    expect(branch).toContain('.catch(');
  });

  it('intercepts a bare /plan in the draft send path before creating a session', () => {
    const draftSource = readFileSync(
      resolve(
        __dirname,
        '..',
        'features',
        'cc-agent',
        'NewMakerDraftRoute.tsx',
      ),
      'utf8',
    );
    // 本地草稿分支(forceReload 命令列表 + toggle);远程草稿分支 toast 提示不 toggle。
    const idx = draftSource.lastIndexOf('handlePlanModeChange(!effectivePlanMode)');
    expect(idx).toBeGreaterThanOrEqual(0);
    // region 从 /plan 拦截块开头(正则匹配处)切到 handlePlanModeChange 之后 ——
    // 不用固定宽度 slice 往回切:注释加长会把断言推离窗口(Codex P1 / Copilot 均提过)。
    const headIdx = draftSource.indexOf("/^\\/plan\\s*$/i.test(message.trim())");
    expect(headIdx).toBeGreaterThanOrEqual(0);
    const region = draftSource.slice(headIdx, idx + 200);
    // 源码是 `/^\/plan\s*$/i.test(message.trim())` —— 用 includes 锁关键片段,
    // 避免正则字面量里反斜杠转义层级出错(CI 上实测过 toMatch 转义会挂)。
    expect(region).toContain('/^\\/plan');
    expect(region).toContain("test(message.trim())");
    // device-link 远程草稿:确认 /plan 归属 desktop 命令(无同名命令)后才 toast 提示
    // 不可用 + return,不静默消费也不放行创建会话(Codex P1:避免 /plan 变成首条消息
    // 发给远程 agent)。Codex P2 修复:远程分支必须在归属判断**之后**,不能先于
    // loadAllCommands 提前 return —— 否则被控端安装的同名 plan skill 会被吞掉。
    expect(draftSource).toContain("t('newChat.collaboration.planModeUnavailableRemoteDraft')");
    expect(draftSource).toContain('isDeviceLinkDraft) {');
    const toastIdx = draftSource.indexOf("t('newChat.collaboration.planModeUnavailableRemoteDraft')");
    const ownershipIdx = draftSource.indexOf("hit.kind === 'desktop'");
    expect(toastIdx).toBeGreaterThan(ownershipIdx);
    // 尊重 palette 优先级:每次 forceReload 拉取 merged 命令列表(不缓存 —— 缓存 key
    // 感知不到同一上下文里 skill 增删,Copilot),仅当无同名命令或命中 desktop 才 toggle
    // (用户装了名为 plan 的 skill 时不拦截,让 /plan 发给 agent —— 与会话路径一致)。
    expect(region).toContain('loadAllCommands');
    expect(region).toContain('forceReload: true');
    expect(region).toContain("hit.kind === 'desktop'");
    // SSH 远程与 ChatInput palette 一致 skipAgentSkills,避免误判本地 skill 归属。
    expect(region).toContain('skipAgentSkills');
    // device-link 远程草稿与 palette 一致传 effectiveDeviceLinkDeviceId,从被控端读
    // agent-builtin / agent-skill(Codex P2:命中被控端同名 plan skill 时放行发送)。
    expect(region).toContain('effectiveDeviceLinkDeviceId');
    // await loadAllCommands 是 handleSend 第一个 await,必须先上在途锁(Copilot):
    // 拉取期间用户切设备/工作区会串台,markSendInFlight 让 pill 立即拒绝。
    expect(region).toContain('markSendInFlight(true)');
    expect(region).toContain('markSendInFlight(false)');
    // 返回 undefined(非 false):ChatInput 对 result === false 会跳过 clearSentComposer,
    // 只有非 false 才会清空 composer 文本 —— /plan 命令文本不能留残影。
    expect(region).not.toContain('return false');
    expect(region).toContain('return;');
  });
});
