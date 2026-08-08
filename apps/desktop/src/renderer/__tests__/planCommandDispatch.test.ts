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
 *   3) CCAgentSessionView:capabilities 未加载(sessionCaps == null)时不乐观 toggle,
 *      仅 toast 提示(避免遗留开启状态 + 远程 RPC 回滚,Greptile P1 / Codex);
 *      已加载且 planMode 缺失/不支持时不执行 toggle 且 toast 提示(Codex);
 *   4) CCAgentSessionView:支持时按当前状态 toggle(setPlanMode(nextEnabled),
 *      nextEnabled 由 getSnapshot 取「当下」planModeEnabled 计算,监听器不依赖闭包旧值;
 *      且失败 rejection 被显式吞掉(不升级为未捕获的 Promise rejection);
 *   5) 草稿路由:handleSend 在创建会话前拦截纯文本 /plan,切换草稿 planMode;
 *      命令列表每次 forceReload(缓存 key 感知不到同一上下文里 skill 增删),SSH 远程
 *      skipAgentSkills,device-link 远程草稿按 effectiveDeviceLinkDeviceId 从被控端读
 *      skill(与 ChatInput palette 语义一致);命中同名 agent skill 时放行发送,
 *      仅当 merged 列表**明确命中 desktop /plan** 时才 toast「远程草稿不可用」/
 *      toggle 草稿 planMode(未命中/拉取失败空列表一律放行,Copilot)。
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
  // 动态定位到分支收尾,不依赖固定长度 slice(注释加长会推远断言,Codex P1 / Copilot):
  // 用分支内具体调用链锚定(而非宽泛的 .catch( —— 分支外残留 .catch( 会造成假阳性,
  // Copilot):setPlanMode(nextEnabled).catch / 不支持 toast。
  const catchIdx = sessionViewSource.indexOf('setPlanMode(nextEnabled).catch', idx);
  const toastIdx = sessionViewSource.indexOf('planModeUnsupportedSession', idx);
  const markers = [catchIdx, toastIdx].filter((v) => v >= 0);
  if (markers.length === 0) throw new Error('no branch end marker after plan branch');
  return sessionViewSource.slice(idx, Math.max(...markers) + 200);
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
    expect(branch).toMatch(/if \(payload\.sessionId\)/);
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

  it('gates /plan on capabilities: no optimistic toggle while loading; toast when loaded but unsupported', () => {
    const branch = planBranchSource();
    // capabilities 未加载(sessionCaps == null,冷启动/远程拉取慢)→ **不乐观 toggle**,
    // 仅 toast 提示稍后重试(Greptile P1:乐观开启 + 能力解析为不支持会遗留状态且远程
    // setPlanMode RPC reject 回滚,自愈不可靠 —— Codex);
    // capabilities 已加载且 planMode.supported === true → toggle;
    // 已加载但缺失/不支持(device-link 老被控端,undefined = 不支持)→ toast 提示而非
    // 静默吞掉(Codex)。
    expect(branch).toContain('sessionCaps == null');
    expect(branch).toContain('planModeCapabilitiesLoading');
    expect(branch).toContain('sessionCaps.planMode?.supported === true');
    expect(branch).toContain('planModeUnsupportedSession');
    expect(branch).toContain('toast.warning(');
  });

  it('re-verifies /plan command ownership with forceReload before dispatching; other desktop commands skip it', () => {
    // Codex P2:allCommandsRef 是会话挂载时的快照,会话期间新增/启用的同名 plan skill
    // 不会被它感知 —— /plan 候选必须 forceReload 复核归属,复核为 agent-skill 则放行
    // 给 agent(与 mergeCommands 优先级 agent-skill > desktop 一致)。
    // Copilot:复核收窄到 cmdName === 'plan',避免 /help /clear 每次执行都强制刷新+扫描。
    const idx = sessionViewSource.indexOf('const maybeDispatchDesktopSlashCommand');
    expect(idx).toBeGreaterThanOrEqual(0);
    const region = sessionViewSource.slice(idx, idx + 1700);
    expect(region).toContain('cmdName === \'plan\'');
    expect(region).toContain('forceReload: true');
    expect(region).toContain('skipAgentSkills: isRemoteSession');
    expect(region).toContain('freshHit && freshHit.kind !== \'desktop\'');
    expect(region).toContain('return false');
  });

  it('toggles plan mode based on the current state when supported', () => {
    const branch = planBranchSource();
    // next 从 getSnapshot 取「当下」planModeEnabled(监听器不依赖闭包旧值,Copilot)
    expect(branch).toContain('setPlanMode(nextEnabled)');
    expect(branch).toContain('getSnapshot(payload.sessionId).planModeEnabled');
    // setPlanMode 持久化失败会 reject —— 必须显式 .catch 吞掉,避免未捕获 rejection
    // (断言具体调用链而非宽泛的 .catch(,防分支外残留命中,Copilot)。
    expect(branch).toContain('setPlanMode(nextEnabled).catch');
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
    // device-link 远程草稿:确认 merged 列表**明确命中 desktop /plan** 后才 toast 提示
    // 不可用 + return,不静默消费也不放行创建会话(Codex P1:避免 /plan 变成首条消息
    // 发给远程 agent)。Codex P2 修复:远程分支必须在归属判断**之后**,不能先于
    // loadAllCommands 提前 return —— 否则被控端安装的同名 plan skill 会被吞掉。
    expect(draftSource).toContain("t('newChat.collaboration.planModeUnavailableRemoteDraft')");
    expect(draftSource).toContain('isDeviceLinkDraft) {');
    const toastIdx = draftSource.indexOf("t('newChat.collaboration.planModeUnavailableRemoteDraft')");
    const ownershipIdx = draftSource.indexOf("hit.kind === 'desktop'");
    expect(toastIdx).toBeGreaterThan(ownershipIdx);
    // 尊重 palette 优先级:每次 forceReload 拉取 merged 命令列表(不缓存 —— 缓存 key
    // 感知不到同一上下文里 skill 增删,Copilot),仅当 merged 列表**明确命中 desktop**
    // /plan 时才 toggle/提示(Copilot:IPC 失败降级空列表时 `!hit` 无法证明归属,
    // 未命中一律放行 —— 本地不误 toggle、远程不误 toast 吞掉同名 skill)。
    expect(region).toContain('loadAllCommands');
    expect(region).toContain('forceReload: true');
    expect(region).toContain("hit.kind === 'desktop'");
    expect(region).toContain('hit && hit.kind');
    expect(region).not.toContain('!hit ||');
    // SSH 远程与 ChatInput palette 一致 skipAgentSkills,避免误判本地 skill 归属。
    expect(region).toContain('skipAgentSkills');
    // device-link 远程草稿与 palette 一致传 effectiveDeviceLinkDeviceId,从被控端读
    // agent-builtin / agent-skill(Codex P2:命中被控端同名 plan skill 时放行发送)。
    expect(region).toContain('effectiveDeviceLinkDeviceId');
    // await loadAllCommands 是 handleSend 第一个 await,必须先上在途锁(Copilot):
    // 拉取期间用户切设备/工作区会串台,markSendInFlight 让 pill 立即拒绝。
    expect(region).toContain('markSendInFlight(true)');
    expect(region).toContain('markSendInFlight(false)');
    // toggle/toast 分支返回 undefined(非 false):ChatInput 对 result === false 会跳过
    // clearSentComposer,只有非 false 才会清空 composer 文本 —— /plan 命令文本不能留残影。
    // 附件保护分支除外(Codex P1):composer 已带附件时不消费 /plan,return false 保留草稿。
    expect(region).toContain('return;');
    expect(region).toContain('files?.length');
    expect(region).not.toContain('handlePlanModeChange(!effectivePlanMode);\n            return false');
  });
});
