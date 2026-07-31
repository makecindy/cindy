/**
 * orcaRemoteRoutingInvariants.test.ts —— 锁住「远程 orca」的接线:所有 orca 团队读 / 管理
 * 消费点必须经 makerTransport 的 `orcaWorkflowsFor(ctx)` / `subscribeOrcaWorkerChanged` 路由
 * (按 ctx session 来源分流本机 / 隧道),不得再直连 `window.electronAPI.localDb.orcaWorkflows`
 * —— 否则远程 lead 的团队会查控制端空库、worker 变更收不到推送(真机实测的「浏览不出来」)。
 *
 * 唯一允许直连的是 makerTransport 自己(路由器本体,含本机分支 + onOrcaWorkerChanged 订阅)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const R = resolve(__dirname, '..');
// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const read = (rel: string) => readFileSync(resolve(R, rel), 'utf8').replace(/\r\n/g, '\n');

const CONSUMERS = [
  'features/cc-agent/hooks/useWorkers.ts',
  'features/cc-agent/hooks/useOrcaWorkerSelection.ts',
  'features/cc-agent/hooks/useOrcaLeadWorkerMap.ts',
  'features/cc-agent/OrcaSplitView.tsx',
  'features/cc-agent/CCAgentSessionView.tsx',
  'features/cc-agent/CCAgentIndexRedirect.tsx',
  'lib/orcaSessionIdentity.ts',
];

describe('orca 远程路由接线不变式', () => {
  it('消费点不再直连 window.electronAPI.localDb.orcaWorkflows(全部经 orcaWorkflowsFor)', () => {
    const offenders = CONSUMERS.filter((f) =>
      read(f).includes('electronAPI.localDb.orcaWorkflows'),
    );
    expect(offenders).toEqual([]);
  });

  it('读 / 管理消费点用 orcaWorkflowsFor(ctx) 路由', () => {
    for (const f of [
      'features/cc-agent/hooks/useWorkers.ts',
      'features/cc-agent/hooks/useOrcaWorkerSelection.ts',
      'features/cc-agent/hooks/useOrcaLeadWorkerMap.ts',
      'features/cc-agent/CCAgentSessionView.tsx',
      'features/cc-agent/CCAgentIndexRedirect.tsx',
      'lib/orcaSessionIdentity.ts',
    ]) {
      expect(read(f), f).toContain('orcaWorkflowsFor(');
    }
  });

  it('useWorkers worker 变更经 subscribeOrcaWorkerChanged(本机/远程分流),不直订本机 IPC', () => {
    const src = read('features/cc-agent/hooks/useWorkers.ts');
    expect(src).toContain('subscribeOrcaWorkerChanged(');
    expect(src).not.toContain('onOrcaWorkerChanged');
  });

  // issue #1170 codex P2:协同入口与策略查询按**粘滞** remoteDeviceId 指向被控端,而
  // enable/disable 这两个 mutation 曾走非粘滞的 makerApiFor —— relay 瞬时重连清空注册表的
  // 窗口内会退回本机,在**控制端**建出或销毁一个 team(本机恰有同 id 会话时还操作错对象)。
  // 这是「同一语义在对称路径上的缺口」,两条必须同口径,所以一起锁。
  it('协同开关的 enable / disable 都用粘滞归属(makerApiForSticky),不用非粘滞 makerApiFor', () => {
    const view = read('features/cc-agent/CCAgentSessionView.tsx');
    expect(view).toContain('makerApiForSticky(collabSessionId).enableOrca(');
    expect(view).not.toContain('makerApiFor(collabSessionId).enableOrca(');
    // 开启后的镜像回流也取粘滞值,否则瞬断窗口内解析成 undefined 会整段跳过,
    // 被控端刚建的 worker 永远进不了控制端注册表。
    expect(view).toContain('getStickySessionDeviceId(collabSessionId)');

    const stop = read('features/cc-agent/hooks/useStopOrcaCollab.ts');
    expect(stop).toContain('makerApiForSticky(leadSessionId).disableOrca(');
    expect(stop).not.toContain('makerApiFor(leadSessionId).disableOrca(');
  });

  // 同一条不变量的第三处漏网(greptile P1 第五轮):远程草稿起目标时,「要不要订阅
  // session:<id>」曾用非粘滞 getSessionDeviceId 判断,而真正发 setGoal 的 goalApiFor
  // 走粘滞归属 —— 瞬断窗口内订阅被跳过、setGoal 照样发到被控端,目标首轮的
  // maker:event/status 推送就落在没有订阅者的窗口里。判据必须与执行端归属同口径。
  it('远程起目标的订阅判据与 setGoal 的归属同口径(都用粘滞)', () => {
    const view = read('features/cc-agent/CCAgentSessionView.tsx');
    const goalConsumer = view.slice(
      view.indexOf('const pendingGoal = consumePendingGoal(sessionId);'),
    );
    const branch = goalConsumer.slice(0, goalConsumer.indexOf('const learnCardsRestoredRef'));
    expect(branch).toContain('const deviceId = getStickySessionDeviceId(sessionId);');
    expect(branch).not.toContain('const deviceId = getSessionDeviceId(sessionId);');
    expect(branch).toContain('deviceLink.subscribe(deviceId,');
    expect(branch).toContain('goalApiFor(sessionId).setGoal(');
  });

  it('makerApiForSticky 住在传输层(归属判定只有一处可改)', () => {
    const src = read('lib/makerTransport.ts');
    expect(src).toContain('export function makerApiForSticky(');
    expect(src).toContain('getStickySessionDeviceId(sessionId)');
  });

  it('makerTransport 路由器本体仍持有本机分支(orcaWorkflowsFor 内部允许直连 + onOrcaWorkerChanged)', () => {
    const src = read('lib/makerTransport.ts');
    expect(src).toContain('export function orcaWorkflowsFor(');
    expect(src).toContain('export function subscribeOrcaWorkerChanged(');
    expect(src).toContain('window.electronAPI.localDb.orcaWorkflows'); // 本机分支
  });

  // 远程 orca lead/worker 会话不在本地 sessionsStore,而在 remoteProjectsStore。
  // OrcaWorkflowRoute / OrcaSplitView 解析 lead/worker 时必须合并两源(useRemoteProjectSessions),
  // 否则远程 lead find 不到 → OrcaWorkflowRoute 把人弹回 /cc-agent(真机实测「打不开」)。
  it('OrcaWorkflowRoute / OrcaSplitView 合并远程会话源(useRemoteProjectSessions),不只读本地', () => {
    for (const f of [
      'features/cc-agent/OrcaWorkflowRoute.tsx',
      'features/cc-agent/OrcaSplitView.tsx',
    ]) {
      expect(read(f), f).toContain('useRemoteProjectSessions');
      expect(read(f), f).toContain('mergeSessionSources');
    }
  });

  it('SessionContentHeader 删除后重定向用远程会话 metadata 解析 Orca route', () => {
    const src = read('features/cc-agent/SessionContentHeader.tsx');
    expect(src).toContain('useRemoteProjectSessions');
    expect(src).toContain('routeSessionById.get(nextSessionId)');
    expect(src).not.toContain('sessions.find((s) => s.id === nextSessionId)');
  });

  it('SessionContentHeader 删除当前隐藏会话时不从全量会话顺序选择跳转目标', () => {
    const src = read('features/cc-agent/SessionContentHeader.tsx');
    expect(src).toContain('const hasVisibleListContext = visibleSessionIds.includes(session.id)');
    expect(src).toContain('pickSessionIdAfterRemoval(\n      visibleSessionIds,');
    expect(src).not.toContain('const sessionIds = [...routeSessionById.keys()]');
  });

  it('detached 右侧栏窗口也挂远程项目镜像,让 Orca tab 按远程 session 来源路由', () => {
    const src = read('components/layout/SidebarWindowLayout.tsx');
    expect(src).toContain(
      "import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects'",
    );
    expect(src).toContain('useDeviceLinkRemoteProjects();');
  });

  it('右侧栏协同 tab close 不带路由副作用,避免 detached 窗口跳回 MainLayout', () => {
    const src = read('features/right-sidebar/plugins/orca-workers/index.tsx');
    expect(src).toContain('navigateOnSuccess: false');
    expect(src).not.toContain('navigateOnSuccess: true');
  });

  it('detached 子窗口消费 browser/file/orca intent,主窗口 helper 不直接写子窗宿主 store', () => {
    const layout = read('components/layout/SidebarWindowLayout.tsx');
    expect(layout).toContain('executeSidebarCommand(cmd)');
    const executor = read('features/right-sidebar/lib/executeSidebarCommand.ts');
    expect(executor).toContain("command.type === 'open-web-browser'");
    expect(executor).toContain("command.type === 'open-file-browser'");
    expect(executor).toContain('searchJump: command.searchJump');

    const fileMenu = read('components/chat/useFileChipContextMenu.tsx');
    expect(fileMenu).not.toContain('rightSidebarWindow.getState');
    expect(fileMenu).not.toContain("type: 'open-file-browser'");
  });

  it('worker 内嵌聊天只把侧栏动作重定向到可见 Lead bucket,不改内容 session 身份', () => {
    const panel = read('features/cc-agent/OrcaWorkerPanel.tsx');
    expect(panel).toContain('sessionIdProp={workerSessionId}');
    expect(panel).toContain('sidebarTargetSessionId={leadSessionId}');

    for (const file of [
      'components/chat/useOpenWithMenu.tsx',
      'components/chat/useFileChipContextMenu.tsx',
      'components/chat/MarkdownRenderer.tsx',
      'components/chat/ImageLightbox.tsx',
    ]) {
      expect(read(file), file).toContain('useSidebarTargetSessionId');
    }

    const markdown = read('components/chat/MarkdownRenderer.tsx');
    const inlineCodeStart = markdown.indexOf('function InlineCodeWithTarget(');
    const inlineCodeEnd = markdown.indexOf('\nexport const MarkdownRenderer', inlineCodeStart);
    const inlineCode = markdown.slice(inlineCodeStart, inlineCodeEnd);
    expect(inlineCode).toContain(
      'const sidebarTargetSessionId = useSidebarTargetSessionId(sessionId ?? fileCtx.sessionId);',
    );
    expect(inlineCode).toContain('{ ...fileCtx, sidebarTargetSessionId }');
  });
});
