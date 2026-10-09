/**
 * 远程 Agent · 已建任务换电脑的渲染端接线(2026-10-07 用户裁决:选模型即可换 Agent 位置)。
 *
 * 起因:Agent 在另一台电脑运行的任务里选了本机模型,选择被转给那台电脑报 Model not found,
 * 之后每次发送都卡住。这里锁住渲染端的几条不变量:
 *   1. 面板浏览的不是 Agent 落点那台的目录时,同引擎 / 跨引擎两条会话链路都改道给 onRelocate;
 *   2. 换位置带着目标电脑进切换事务,意图期内的后续改选沿用意图里的电脑;
 *   3. 意图期内模型目录跟随意图里的电脑,选回任务当前所在电脑不带位置;
 *   4. 只对本机任务、或支持远程 Agent 的被控电脑上的任务开放,且要能走切换事务(SSH / 旧被控端 /
 *      共享任务访客 / 协同任务不开放)。
 *
 * 2026-10-09 起被控电脑上的任务也开放(用户反馈:A 远控 B 的任务选不到 C 的远程供应商,手机能)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(resolve(__dirname, relative), 'utf8').replace(/\r\n/g, '\n');

const selectorSource = read('../components/new-chat/ModelSelector.tsx');
const chatInputSource = read('../components/new-chat/ChatInput.tsx');
const sessionViewSource = read('../features/cc-agent/CCAgentSessionView.tsx');

describe('ModelSelector:浏览别的电脑的目录时改道换位置', () => {
  it('只在已建任务、且浏览的不是落点目录时改道', () => {
    expect(selectorSource).toContain(
      'remoteAgent?.onRelocate && !onUnifiedSelect && !browsingSelectedCatalog',
    );
  });

  it('行选中在同引擎会话链路之前先走 relocate', () => {
    const relocateBranch = selectorSource.indexOf('if (relocate) {');
    const sessionApply = selectorSource.indexOf('return applyUnifiedSessionSelect({', relocateBranch);
    expect(relocateBranch).toBeGreaterThan(0);
    expect(sessionApply).toBeGreaterThan(relocateBranch);
  });

  it('跨引擎行也改道:替换 onCrossEngineSelect / onCrossEngineConfigure,并把整份过滤器交给面板', () => {
    const filter = selectorSource.indexOf('const panelSessionEngineFilter =');
    expect(filter).toBeGreaterThan(0);
    expect(selectorSource.indexOf('onCrossEngineSelect: (args', filter)).toBeGreaterThan(filter);
    expect(selectorSource.indexOf('onCrossEngineConfigure: (args', filter)).toBeGreaterThan(filter);
    expect(selectorSource).toContain(
      '{...(panelSessionEngineFilter ? { sessionEngineFilter: panelSessionEngineFilter } : {})}',
    );
  });

  it('改道的行带上所属电脑', () => {
    expect(selectorSource).toContain('relocate!({ ...row, agentDevice: remoteBrowseDevice })');
  });
});

describe('ChatInput:换位置进切换事务', () => {
  it('位置来自显式选择,否则沿用意图里的电脑;与任务当前所在电脑相同就不带', () => {
    expect(chatInputSource).toContain(
      'overrides?.agentDeviceId !== undefined ? overrides.agentDeviceId : pendingAgentDeviceId;',
    );
    expect(chatInputSource).toContain('requestedAgentDeviceId !== agentDeviceId');
    expect(chatInputSource).toContain('{ agentDeviceId: relocateTo },');
  });

  it('回声匹配把位置算进意图;登记时写入位置;换电脑不写本机新建任务记忆', () => {
    expect(chatInputSource).toContain('registeredIntent.agentDeviceId === relocateTo;');
    expect(chatInputSource).toContain(
      '...(relocateTo !== undefined ? { agentDeviceId: relocateTo } : {}),',
    );
    // 换电脑只把档位记进目标目录的记忆,不走写新建任务记忆的 syncSessionDraftModelPrefs。
    expect(chatInputSource.split('if (relocateTo !== undefined) {').length - 1).toBe(2);
    expect(chatInputSource).not.toContain('if (relocateTo === undefined) syncSessionDraftModelPrefs(');
  });

  it('意图期内目录跟随意图里的电脑', () => {
    expect(chatInputSource).toContain(
      'const catalogDeviceId = effectiveAgentDeviceId ?? deviceLinkDeviceId ?? undefined;',
    );
  });

  it('只对本机任务、或支持远程 Agent 的被控端任务开放,且要能走切换事务', () => {
    expect(chatInputSource).toContain(
      'if (!sessionId || !agentLocationAware || remoteHostId || !sessionEngineFilter) return undefined;',
    );
    expect(chatInputSource).toContain('agentDeviceId: selection.agentDevice?.deviceId ?? null,');
  });
});

describe('被控电脑上的任务:换 Agent 所在电脑', () => {
  it('只在调用方传了候选电脑(被控端支持)、不是 SSH / 共享任务访客时开放;已建任务还要位置本机读得到', () => {
    const start = chatInputSource.indexOf('const deviceLinkAgentLocation =');
    expect(start).toBeGreaterThan(0);
    const block = chatInputSource.slice(start, chatInputSource.indexOf('}));\n', start));
    for (const guard of [
      '!!deviceLinkDeviceId',
      '!remoteHostId',
      '!sharedGuest',
      'remoteAgentDevices !== undefined',
      // 草稿(还没有 sessionId)的落点只来自候选电脑;已建任务另看当前与挂着的位置。
      '(!sessionId ||',
      'controlledTaskAgentLocationReadable({',
    ]) {
      expect(block).toContain(guard);
    }
    expect(chatInputSource).toContain(
      'const agentLocationAware = !deviceLinkDeviceId || deviceLinkAgentLocation;',
    );
    // 不支持时位置一律按被控电脑处理,与改动前相同。
    expect(chatInputSource).toContain(
      'const agentDeviceId = agentLocationAware ? (_agentDeviceId ?? null) : null;',
    );
  });

  it('换位置带给被控端的前提与面板入口同一个判定', () => {
    const start = chatInputSource.indexOf('const relocateTo =');
    expect(start).toBeGreaterThan(0);
    expect(chatInputSource.slice(start, start + 200)).toContain('agentLocationAware &&');
  });

  it('面板不浏览其他电脑时列被控电脑的目录与它的镜像记忆', () => {
    expect(chatInputSource).toContain(
      '...(deviceLinkDeviceId ? { homeDeviceId: deviceLinkDeviceId } : {}),',
    );
    expect(chatInputSource).toContain(
      '...(taskComputerModelMemory ? { localModelMemory: taskComputerModelMemory } : {}),',
    );
    expect(selectorSource).toContain(
      'const deviceId = remoteAgent ? (remoteBrowse?.deviceId ?? homeDeviceId) : deviceIdProp;',
    );
    // 只有浏览其他电脑时才按「允许被远程调用」裁剪;被控电脑自己的目录照远程控制列全部。
    expect(selectorSource).toContain(
      'const remoteAgentBrowsing = remoteAgent !== undefined && remoteBrowse !== null;',
    );
  });

  it('改回被控电脑的确认标题写那台电脑的名字', () => {
    expect(chatInputSource).toContain('device: deviceLinkDeviceName || deviceLinkDeviceId,');
  });

  it('会话视图:候选电脑去掉被控电脑本身,不并入本机收到的分享;目录跟随 Agent 所在电脑', () => {
    expect(sessionViewSource).toContain('controlledTaskSupportsAgentLocation(session) &&');
    expect(sessionViewSource).toContain('!isSharedTaskPeer(remoteDeviceId) &&');
    const branch = sessionViewSource.indexOf(
      'if (remoteDeviceId) {\n      return controlledAgentLocation',
    );
    expect(branch).toBeGreaterThan(0);
    const remoteBranch = sessionViewSource.slice(
      branch,
      sessionViewSource.indexOf(': undefined;', branch),
    );
    expect(remoteBranch).toContain('selectControlledTaskAgentDevices({');
    expect(remoteBranch).not.toContain('providerShareDevices');
    expect(sessionViewSource).toContain(
      'const catalogDeviceId = controlledAgentDeviceId ?? remoteDeviceId ?? agentDeviceId;',
    );
    expect(sessionViewSource).toContain('deviceLinkDeviceName={controlledDeviceName}');
  });
});
