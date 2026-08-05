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
