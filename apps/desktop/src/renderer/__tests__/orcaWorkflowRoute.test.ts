/**
 * OrcaWorkflowRoute regression tests.
 *
 * The route keeps parse/lookup helpers private, so these tests mirror the small
 * pure worker-selection contract and statically check source invariants.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface TestSession {
  id: string;
  agentKind?: 'cc' | 'codex';
}

interface TestWorkerRecord {
  id: string;
  sessionId: string;
}

function findWorkerSession(params: {
  leadSession: TestSession | null;
  sessions: TestSession[];
  workerRecords: TestWorkerRecord[];
  focusedWorkerSessionId?: string | null;
  workerSessionId: string | null;
}): TestSession | null {
  const { leadSession, sessions, workerRecords, focusedWorkerSessionId, workerSessionId } = params;
  if (!leadSession) return null;
  if (focusedWorkerSessionId) {
    const focusedWorkerRecord = workerRecords.find((w) => w.sessionId === focusedWorkerSessionId);
    if (focusedWorkerRecord) {
      return sessions.find((s) => s.id === focusedWorkerRecord.sessionId) ?? null;
    }
  }
  if (workerSessionId) {
    const explicitWorkerRecord = workerRecords.find((w) => w.sessionId === workerSessionId);
    if (explicitWorkerRecord) {
      return sessions.find((s) => s.id === explicitWorkerRecord.sessionId) ?? null;
    }
  }
  const firstWorkerRecord = workerRecords[0];
  return firstWorkerRecord
    ? sessions.find((s) => s.id === firstWorkerRecord.sessionId) ?? null
    : null;
}

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

const routeSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'OrcaWorkflowRoute.tsx'),
  'utf8',
);
const splitViewSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'OrcaSplitView.tsx'),
  'utf8',
);
const workerPanelSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'OrcaWorkerPanel.tsx'),
  'utf8',
);
const workersTabBodySource = readTextLf(
  resolve(
    __dirname,
    '..',
    'features',
    'right-sidebar',
    'plugins',
    'orca-workers',
    'OrcaWorkersTabBody.tsx',
  ),
  'utf8',
);
const workerSelectionHookSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'hooks', 'useOrcaWorkerSelection.ts'),
  'utf8',
);
const workdirBrowseRouteSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'workdir-browse', 'WorkdirBrowseRoute.tsx'),
  'utf8',
);
const sessionViewSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);
const chatInputSource = readTextLf(
  resolve(__dirname, '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
);
const atMentionPanelSource = readTextLf(
  resolve(__dirname, '..', 'components', 'new-chat', 'AtMentionPanel.tsx'),
  'utf8',
);
const sessionStatusIconSource = readTextLf(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'SessionStatusIcon.tsx'),
  'utf8',
);
const rightSidebarTabBarSource = readTextLf(
  resolve(__dirname, '..', 'features', 'right-sidebar', 'TabBar.tsx'),
  'utf8',
);
const orcaWorkersPluginSource = readTextLf(
  resolve(__dirname, '..', 'features', 'right-sidebar', 'plugins', 'orca-workers', 'index.tsx'),
  'utf8',
);
const messageStreamSource = readTextLf(
  resolve(__dirname, '..', 'components', 'chat', 'MessageStream.tsx'),
  'utf8',
);
const mainLayoutSource = readTextLf(
  resolve(__dirname, '..', 'components', 'layout', 'MainLayout.tsx'),
  'utf8',
);
const templatePlaceholder = (name: string) => `${String.fromCharCode(36)}{${name}}`;

describe('OrcaWorkflowRoute worker session lookup contract', () => {
  const lead: TestSession = { id: 'lead-1' };
  const workerA: TestSession = { id: 'worker-a', agentKind: 'codex' };
  const workerB: TestSession = { id: 'worker-b', agentKind: 'cc' };

  it('returns explicit worker only when workflow records link it to the lead', () => {
    expect(findWorkerSession({
      leadSession: lead,
      sessions: [lead, workerA, workerB],
      workerRecords: [{ id: 'worker-record-a', sessionId: workerA.id }],
      workerSessionId: workerA.id,
    })).toBe(workerA);
  });

  it('falls back to the first workflow worker record', () => {
    expect(findWorkerSession({
      leadSession: lead,
      sessions: [lead, workerA, workerB],
      workerRecords: [
        { id: 'worker-record-b', sessionId: workerB.id },
        { id: 'worker-record-a', sessionId: workerA.id },
      ],
      workerSessionId: 'unlinked-worker',
    })).toBe(workerB);
  });

  it('returns the focused worker before the URL hint', () => {
    expect(findWorkerSession({
      leadSession: lead,
      sessions: [lead, workerA, workerB],
      workerRecords: [
        { id: 'worker-record-a', sessionId: workerA.id },
        { id: 'worker-record-b', sessionId: workerB.id },
      ],
      focusedWorkerSessionId: workerB.id,
      workerSessionId: workerA.id,
    })).toBe(workerB);
  });

  it('returns null without workflow records', () => {
    expect(findWorkerSession({
      leadSession: lead,
      sessions: [lead, workerA],
      workerRecords: [],
      workerSessionId: null,
    })).toBe(null);
  });
});

describe('OrcaWorkflowRoute source invariants', () => {
  it('uses the right-sidebar UsersRound mark for every collaboration entry point', () => {
    expect(rightSidebarTabBarSource).toContain("'orca-workers': UsersRound");
    expect(orcaWorkersPluginSource).toContain('<UsersRound size={13} />');
    expect(atMentionPanelSource).toContain('collaboration: UsersRound');
    expect(atMentionPanelSource).not.toContain('<Puzzle');
    expect(sessionStatusIconSource).toContain('<UsersRound');
    expect(sessionStatusIconSource).not.toContain('<Puzzle');
    expect(sessionStatusIconSource).toContain("'text-[var(--cmd-palette-item-meta)]'");
  });

  it('keeps policy reasons scoped to the disabled collaboration menu item', () => {
    expect(chatInputSource).toContain('const policyDisabled = collaboration.disabled === true;');
    expect(chatInputSource).toContain('disabledReason: collaboration.disabledReason');
    expect(chatInputSource).toContain('policyDisabled && !retryable');
    expect(chatInputSource).toContain('collaboration.onDisabledActivate?.();');
  });

  it('keeps the active collaboration tooltip free of policy-disabled reasons', () => {
    expect(sessionViewSource).toMatch(
      /disabledReason:\s*!collabEnabled\s*\?\s*collabPolicy\.loading[\s\S]*?:\s*undefined\s*:\s*undefined,/,
    );
  });

  it('retries an unavailable policy from the disabled collaboration control', () => {
    expect(sessionViewSource).toContain('onDisabledActivate: collabPolicy.unavailable');
    expect(sessionViewSource).toContain('void collabPolicy.refresh().then((policy) => {');
    expect(sessionViewSource).toContain('if (policy.enabled && !policy.unavailable) {');
    expect(chatInputSource).toContain('if (collaboration) {');
    expect(chatInputSource).toContain('!!collaboration.onDisabledActivate');
  });

  it('does not subscribe to project policy updates from the legacy Orca route', () => {
    // eligible 的判据本体收敛进了 resolveCollabEntryPolicy(issue #1170:草稿与会话视图
    // 曾各写一份,同一个 device-link 项目两边给出相反答案)。这里守的仍是原来那件事 ——
    // legacy /orca 路由(orcaMode)必须先被 `!orcaMode &&` 短路掉,否则它也会去跑项目
    // 策略查询并订阅刷新。
    expect(sessionViewSource).toContain(
      'const collabPolicyEligible = !orcaMode && collabEntry.eligible;',
    );
    expect(sessionViewSource).toContain('resolveCollabEntryPolicy({');
  });

  it('keeps /orca as a legacy compatibility redirect to the plain lead route', () => {
    expect(routeSource).toContain('const { sessions, isLoading } = useCCSessions()');
    expect(routeSource).toContain('if (!sessionId || isLoading) return;');
    expect(routeSource).toContain("navigate('/cc-agent', { replace: true })");
    expect(routeSource).not.toContain('revealOrcaWorkersTab');
    expect(routeSource).toContain("params.delete('worker')");
    expect(routeSource).toContain("params.delete('workerAgent')");
    expect(routeSource).toContain('leadSessionId: sessionId');
    expect(routeSource).toContain('focusWorkerSessionId: workerSessionId');
    expect(routeSource).toContain('navigate(`/cc-agent/${sessionId}${nextSearch ? `?${nextSearch}` : \'\'}`, {');
    expect(routeSource).toContain('const orcaWorkersReveal = isOrcaLeadSession(leadSession)');
    expect(routeSource).toContain('orcaWorkersReveal,');
    expect(routeSource).not.toContain('<CCAgentSessionView');
    expect(routeSource).not.toContain('<OrcaSplitView');
  });

  it('does not use fork parentSessionId or title-linked worker lookup for Orca mapping', () => {
    expect(splitViewSource).not.toContain('parentSessionId: actualLeadSessionId');
    expect(splitViewSource).not.toContain('isOrcaWorkerLinkedToLead');
    expect(splitViewSource).not.toMatch(/Orca Worker\[[^\]]+\]/);
  });

  it('does not persist workerAgent route hints in the worker pane', () => {
    expect(splitViewSource).not.toContain("searchParams.get('workerAgent')");
    expect(splitViewSource).not.toContain('workerAgentKindHint');
    expect(splitViewSource).toContain('normalizeOrcaDisplayAgentKind(');
  });

  it('renders lead labels with dynamic agent text and a VendorIcon in both Orca layouts', () => {
    expect(splitViewSource).toContain("const leadPaneLabel = t('orca.split.leadLabel', {");
    expect(splitViewSource).toContain('agent: orcaAgentLabel(leadAgentKind)');
    expect(splitViewSource).toContain('const leadPaneIcon = (');
    expect(splitViewSource).toContain('<VendorIcon');
    expect(splitViewSource).toContain('{leadPaneIcon}');
    expect(splitViewSource).toContain('{leadPaneLabel}');
    expect(splitViewSource).not.toContain("{t('orca.split.leadLabel')}");
    expect(splitViewSource).not.toContain("label={t('orca.split.leadLabel')}");
  });

  it('keeps missing worker panes as placeholders instead of editable inputs', () => {
    expect(splitViewSource).toContain("workerEmptyLabel ?? t('orca.split.waitingForWorker')");
    expect(chatInputSource).toContain(
      "autofocus: !disableAutofocus && !disabled ? 'end' : false",
    );
    // The composer is also temporarily read-only during the bounded effort-runtime
    // preflight, so a pending send cannot clear text entered after its snapshot.
    expect(chatInputSource).toContain('editor?.setEditable(!composerTypingLocked)');
  });

  it('does not block collaboration tab opening on worker SDK bootstrap', () => {
    const requestEnable = sessionViewSource.indexOf('const requestEnableCollab = useCallback');
    // device-link 按粘滞 deviceId 走共享远程 handoff；本机会话仍直调本机 IPC。
    // reveal promise 必须在两条 mutation 分支之前启动，不能等 Worker bootstrap 完成后才开 tab。
    const remoteEnableCall = sessionViewSource.indexOf(
      'await enableRemoteCollabForSession({',
      requestEnable,
    );
    const localEnableCall = sessionViewSource.indexOf(
      'await window.electronAPI.maker.enableOrca(collabSessionId, enableOptions)',
      requestEnable,
    );
    const openTab = sessionViewSource.indexOf(
      'revealOrcaWorkersTab(collabSessionId)',
      requestEnable,
    );

    expect(requestEnable).toBeGreaterThan(-1);
    expect(remoteEnableCall).toBeGreaterThan(requestEnable);
    expect(localEnableCall).toBeGreaterThan(requestEnable);
    expect(openTab).toBeGreaterThan(requestEnable);
    expect(openTab).toBeLessThan(remoteEnableCall);
    expect(openTab).toBeLessThan(localEnableCall);
    expect(sessionViewSource).not.toContain(
      `/cc-agent/orca/${templatePlaceholder('collabSessionId')}`,
    );
  });

  it('starts manual collaboration through the detailed worker form', () => {
    expect(sessionViewSource).toContain('<CreateWorkerPopover');
    expect(sessionViewSource).toContain('onOpenDetails');
    expect(sessionViewSource).toContain('role: form.role');
    expect(sessionViewSource).toContain('label: createWorkerLabel(form.role, [])');
    expect(sessionViewSource).toContain('model: form.model');
    expect(sessionViewSource).toContain('delegateTask: form.initialTask || undefined');
    expect(chatInputSource).toContain('if (collaboration) {');
    expect(chatInputSource).toContain('collaboration.onOpenDetails();');
  });

  it('maps manual collaboration start failures through i18n instead of raw IPC messages', () => {
    expect(sessionViewSource).toContain('getCollaborationStartErrorMessage(err, t, {');
    expect(sessionViewSource).toContain('remoteDevice: Boolean(remoteDeviceId)');
    expect(sessionViewSource).not.toContain("ipcError?.message ?? t('newChat.collaboration.startFailed'");
  });

  it('keeps Orca search jump state available for the target pane', () => {
    expect(sessionViewSource).toContain('if (!sessionId || !searchJump) return;');
    expect(sessionViewSource).toContain(`if (searchJump.sessionId !== sessionId) {
      if (!session) return;`);
    // 陈旧跳转只由路由主权实例回收：Orca 视图与分屏嵌入 pane 都不得取消
    // owner 正在消费的跳转。
    expect(sessionViewSource).toContain(`if (!isOrcaMode && !isOrcaLeadSessionView && ownsWindowRoute) {
        clearSearchJumpState();
      }`);
    expect(sessionViewSource).toContain('...(workerSearchJump ? { searchJump: workerSearchJump } : {})');
    expect(sessionViewSource).toContain('...(workerSearchJump ? { searchJump: undefined } : {})');
    expect(workerPanelSource).toContain('searchJumpProp={searchJump}');
    expect(workerPanelSource).toContain('onSearchJumpConsumed={onSearchJumpConsumed}');
  });

  it('reveals draft-created Orca worker tabs from route state after the lead route owns the session', () => {
    expect(sessionViewSource).toContain('function parseOrcaWorkersRevealState(state: unknown)');
    expect(sessionViewSource).toContain('reveal?.leadSessionId && reveal.leadSessionId !== sessionId');
    expect(sessionViewSource).toContain('const hasWorkerSearchJump = Boolean(');
    expect(sessionViewSource).toContain('routeWorkerHint.hasWorkerParam || !!orcaWorkersReveal || hasWorkerSearchJump');
    expect(sessionViewSource).toContain('const shouldRevealWorkersTab = hasExplicitOrcaWorkersReveal || shouldPassiveRevealWorkersTab;');
    expect(sessionViewSource).toContain(
      'if (!ownsRoute || !collabEnabled || isCompactRail || !sessionId) return;',
    );
    expect(sessionViewSource).toContain('orcaWorkersReveal?.focusWorkerSessionId ??');
    expect(sessionViewSource).toMatch(
      /hasWorkerSearchJump\s*\?\s*\(?searchJump\?\.sessionId\s*\?\?\s*null\)?\s*:\s*null/,
    );
    expect(sessionViewSource).toContain('orcaWorkersReveal: undefined');
    expect(sessionViewSource).toContain("routeResult === 'stale-context' && shouldRevealWorkersTab");
    expect(sessionViewSource).toContain("routeResult !== 'attached' && routeResult !== 'routed'");
  });

  it('passively reveals the collaboration tab only for plain Orca Lead routes with no collapsed record', () => {
    expect(sessionViewSource).toContain("import { readPanelCollapsedRecord } from '@/layout/collapsePrefs';");
    expect(sessionViewSource).toContain("import {");
    expect(sessionViewSource).toContain('shouldRevealOrcaWorkersAfterPaint');
    expect(sessionViewSource).toContain('shouldRevealOrcaWorkersBeforeFirstPaint');
    expect(sessionViewSource).toContain('const passiveOrcaWorkersRevealSessionRef = useRef<string | null>(null);');
    expect(sessionViewSource).toContain('const rightSidebarCollapsedRecord = sessionId');
    expect(sessionViewSource).toContain('const shouldFirstFrameRevealOrcaWorkers = shouldRevealOrcaWorkersBeforeFirstPaint({');
    expect(sessionViewSource).toContain('hasExplicitReveal: hasExplicitOrcaWorkersReveal');
    expect(sessionViewSource).toContain("hasSynchronousSessionIdentity: sessionFromList?.orcaRole === 'lead'");
    expect(sessionViewSource).toContain('initialCollapsed={shouldFirstFrameRevealOrcaWorkers ? false : undefined}');
    expect(sessionViewSource).toContain('writeInitialCollapsedRecord={shouldFirstFrameRevealOrcaWorkers}');
    expect(sessionViewSource).toContain('passiveOrcaWorkersRevealSessionRef.current !== sessionId &&');
    expect(sessionViewSource).toContain('shouldRevealOrcaWorkersAfterPaint({');
    expect(sessionViewSource).toContain('const shouldPassiveRevealWorkersTab =');
    expect(sessionViewSource).toContain('passiveOrcaWorkersRevealSessionRef.current = sessionId;');
    expect(sessionViewSource).toContain('const focusWorkerSessionId = hasExplicitOrcaWorkersReveal');
    expect(sessionViewSource).toContain(': null;');
    expect(sessionViewSource).toContain(
      '...(shouldFirstFrameRevealOrcaWorkers ? { animate: false } : {}),',
    );
    expect(sessionViewSource).not.toContain(
      '...(shouldRevealForMissingCollapsedRecord ? { animate: false } : {}),',
    );
  });

  it('sets passive collaboration sidebar collapsed state during the route layout declaration', () => {
    expect(sessionViewSource).toContain('useLayoutEffect(() => {');
    expect(sessionViewSource).toContain(
      'declare(sessionId, { initialCollapsed, writeInitialCollapsedRecord, subagentsAvailable });',
    );
    // The declaration is multi-line since the Subagents entry also follows
    // durable Pi runs (a task switched off Pi keeps the tab while its runs
    // exist), so the attribute and its expression are pinned separately.
    expect(sessionViewSource).toContain('subagentsAvailable={');
    expect(sessionViewSource).toContain(
      "(session.agentKind === 'pi' && !session.remoteHostId) || durablePiRunsPresent",
    );
    // The harness alone must not declare the entry for an SSH-hosted task:
    // `agents/pi` disables the durable Subagent extension whenever
    // `remoteHostId` is set, so such a task can never produce a run and the tab
    // would stay empty while its controls addressed the local filesystem.
    expect(sessionViewSource).not.toContain(
      "session ? session.agentKind === 'pi' || durablePiRunsPresent : undefined",
    );
    expect(mainLayoutSource).toContain('const declareRightSidebarSessionId = useCallback');
    expect(mainLayoutSource).toContain('const nextCollapsed = hasInitialCollapsed');
    expect(mainLayoutSource).toContain('setIsRightSidebarCollapsed(nextCollapsed);');
    expect(mainLayoutSource).toContain('writeCollapsedFor(sessionId, nextCollapsed);');
    expect(mainLayoutSource).toContain('setRightSidebarSessionId: declareRightSidebarSessionId');
  });

  it('lets search jumps and explicit tab hints mount the targeted worker before focused-worker fallback', () => {
    const searchJumpPriority = workerSelectionHookSource.indexOf('if (effectiveSearchJumpWorkerSessionId)');
    const hintPriority = workerSelectionHookSource.indexOf('if (focusWorkerHintSessionId)', searchJumpPriority);
    const focusedWorkerFallback = workerSelectionHookSource.indexOf('if (focusedWorker)', hintPriority);

    expect(workerSelectionHookSource).toContain('const searchJumpWorkerSessionId =');
    expect(workerSelectionHookSource).toContain('const [searchJumpPinnedWorkerSessionId, setSearchJumpPinnedWorkerSessionId]');
    expect(workerSelectionHookSource).toContain('const [focusWorkerPinnedSessionId, setFocusWorkerPinnedSessionId]');
    expect(workerSelectionHookSource).toContain('setSearchJumpPinnedWorkerSessionId(null);');
    expect(workerSelectionHookSource).toContain('setFocusWorkerPinnedSessionId(null);');
    expect(searchJumpPriority).toBeGreaterThan(-1);
    expect(hintPriority).toBeGreaterThan(searchJumpPriority);
    expect(focusedWorkerFallback).toBeGreaterThan(-1);
    expect(searchJumpPriority).toBeLessThan(focusedWorkerFallback);
    expect(hintPriority).toBeLessThan(focusedWorkerFallback);
  });

  it('reports the actual Orca pane session to Agent Island', () => {
    expect(splitViewSource).toContain('const agentIslandVisibleSessionIds = useMemo');
    expect(splitViewSource).toContain('reportAgentIslandVisibility = true');
    expect(splitViewSource).toContain('if (!reportAgentIslandVisibility) return null;');
    expect(splitViewSource).not.toContain('if (!navigateOnStop) return null;');
    expect(splitViewSource).not.toContain('if (!navigateOnStop) return;');
    expect(splitViewSource).toContain("togglePane === 'worker' ? (workerSession?.id ?? null) : leadSessionId");
    expect(splitViewSource).toContain('const syncAgentIslandVisibleSession = useCallback');
    expect(splitViewSource).toContain('window.electronAPI.agentIsland?.setVisibleSession?.(agentIslandVisibleSessionIds)');
    expect(splitViewSource).toContain("window.addEventListener('focus', syncAgentIslandVisibleSession)");
  });

  it('reports the visible right-sidebar collaboration worker sessions to Agent Island', () => {
    expect(workerPanelSource).toContain("import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';");
    expect(workerPanelSource).toContain('if (!isAgentIslandSupported()) return;');
    expect(workerPanelSource).toContain('viewVisible && workerSessionId && workerSessionId !== leadSessionId');
    expect(workerPanelSource).toContain('[leadSessionId, workerSessionId]');
    expect(workerPanelSource).toContain('window.electronAPI.agentIsland?.setVisibleSession?.(visibleSessionIds)');
  });

  it('does not navigate the detached sidebar window to settings from the worker toolbar', () => {
    // 硬上限时 + 按钮跳转到协同设置（codex P1 逃生口），但分离侧栏窗口与 device-link 受控面板
    // 不能整壳替换成设置路由（前者固定 /sidebar-window 壳路由，后者上限走 device-link 远程路径）。
    // 实现用 onOpenSettings={isSidebarWindow() || deviceId !== null ? undefined : handleOpenSettings} 在调用处守卫：
    // 两类面板下传 undefined，+ 按钮回退为 disabled（不再呈现点了没反应的「设置 · 协同」按钮）。
    expect(workerPanelSource).toContain("import { isSidebarWindow } from '@/lib/sidebarWindow';");
    expect(workerPanelSource).toContain('onOpenSettings={isSidebarWindow() || deviceId !== null ? undefined : handleOpenSettings}');
    expect(workerPanelSource).toContain("navigate('/settings?section=collaboration')");
    expect(workerPanelSource).not.toContain('settingsEnabled');
    expect(workersTabBodySource).toContain("import { isSidebarWindow } from '@/lib/sidebarWindow';");
    expect(workersTabBodySource).toContain('<OrcaWorkerPanel {...workerPanelProps} />');
    expect(workersTabBodySource).toContain('<RoutedOrcaWorkerPanel {...workerPanelProps} />');
  });

  it('marks the collaboration worker chat as sidebar-embedded so it cannot replace the host route', () => {
    expect(workerPanelSource).toContain('navigationMode="sidebar-embedded"');
    expect(workerPanelSource).toContain('sidebarTargetSessionId={leadSessionId}');
    expect(sessionViewSource).toContain('sidebarTargetSessionId={sidebarTargetSessionId}');
    expect(sessionViewSource).toContain("const ownsWindowRoute = navigationMode === 'route-owner';");
    expect(sessionViewSource).toContain('ownsWindowRoute && handoffFrom');
    expect(sessionViewSource).toContain('canNavigateSession && session?.parentSessionId');
    expect(sessionViewSource).toContain(
      "const canNavigateSession = ownsWindowRoute || navigationMode === 'split-pane';",
    );
    expect(sessionViewSource).toMatch(
      /sidebarPanelHostSessionId=\{\s*ownsRoute \|\| navigationMode === 'split-pane' \? sessionId : undefined\s*\}/,
    );
    expect(sessionViewSource).toContain(
      'onForkStripEncrypted={canNavigateSession ? handleForkStripEncrypted : undefined}',
    );
  });

  it('waits for detached bootstrap before mounting or writing the embedded right sidebar', () => {
    expect(mainLayoutSource).toContain('rsbWindow.loaded && !rsbDetached ? (');
    expect(mainLayoutSource).toContain('if (!sessionId || !rsbWindow.loaded || rsbDetached) return;');
    expect(mainLayoutSource).toContain("routeSidebarCommand({ type: 'open-terminal', sessionId })");
    expect(mainLayoutSource).toContain('const windowState = getRsbWindowUiState();');
    expect(mainLayoutSource).toContain('const currentSessionId = rightSidebarSessionIdRef.current;');
    expect(mainLayoutSource).toContain('sessionId: targetSessionId');
    expect(mainLayoutSource).toContain(
      "if (visibility === 'open' && opts.userInitiated !== false)",
    );
    expect(mainLayoutSource).toContain('navigateToSessionRef.current?.(targetSessionId)');
  });

  it('passes Orca lead vendor options when sending from the plain lead route', () => {
    expect(sessionViewSource).toContain('const orcaLeadVendorOptions =');
    expect(sessionViewSource).toMatch(
      /sessionId\s*&&\s*session\s*!==\s*null\s*&&\s*isOrcaLeadSession\(session\)/,
    );
    expect(sessionViewSource).not.toContain('isOrcaMode && sessionId && isOrcaLeadSession(session)');
    expect(sessionViewSource).toContain("vendorOptions: { orcaRole: 'lead', orcaLeadSessionId: sessionId }");
  });

  it('shows the Lead identity bar only in the plain Orca Lead route', () => {
    expect(sessionViewSource).toContain(
      'const ownsRoute = routeOwner ?? (!sessionIdProp && !isCompactRail && !isOrcaMode);',
    );
    expect(sessionViewSource).toContain('const collabEnabled = isOrcaLeadSessionView;');
    expect(sessionViewSource).toContain('const showOrcaLeadIdentityBar = ownsRoute && collabEnabled;');
    expect(sessionViewSource).toContain("t('orca.split.leadLabel', {");
    expect(sessionViewSource).toContain('orcaAgentLabel(leadAgentKind)');
    expect(sessionViewSource).toContain('<VendorIcon');
    expect(sessionViewSource).toContain('{showOrcaLeadIdentityBar && (');
    expect(sessionViewSource).not.toContain('maximizePaneAria');
    expect(sessionViewSource).not.toContain('restorePaneAria');
  });

  it('reveals or closes the collaboration tab only on mounted non-compact state edges', () => {
    const edgeEffect = sessionViewSource.slice(
      sessionViewSource.indexOf('const prevCollabEnabledRef'),
      sessionViewSource.indexOf('// F-COLLAB: 关闭协同复用'),
    );
    const mountGuard = edgeEffect.indexOf('if (prevCollabEnabledRef.current === null) {');
    const compactGuard = edgeEffect.indexOf('if (isCompactRail) return;');
    const revealEdge = edgeEffect.indexOf('if (!prev && collabEnabled) {');
    const revealCall = edgeEffect.indexOf('revealOrcaWorkersTab(collabSessionId)');
    const closeEdge = edgeEffect.indexOf('if (prev && !collabEnabled) {');
    const closeCall = edgeEffect.indexOf('closeOrcaWorkersTabAfterTeamEnd(collabSessionId)');

    expect(mountGuard).toBeGreaterThanOrEqual(0);
    expect(compactGuard).toBeGreaterThan(mountGuard);
    expect(edgeEffect.slice(mountGuard, compactGuard)).toContain('return;');
    expect(revealEdge).toBeGreaterThan(compactGuard);
    expect(revealCall).toBeGreaterThan(revealEdge);
    expect(edgeEffect.slice(revealCall, closeEdge)).toContain('return;');
    expect(closeEdge).toBeGreaterThan(revealCall);
    expect(closeCall).toBeGreaterThan(closeEdge);
    // 新的 false→true 外部意图覆盖旧折叠历史；mount 的常驻恢复逻辑仍在上方 effect。
    expect(edgeEffect).not.toContain('rightSidebarCollapsedRecord');
  });

  it('reports embedded doc-mode Orca rail visibility only while the rail is open', () => {
    expect(workdirBrowseRouteSource).not.toContain('navigateOnStop={false}');
    expect(workdirBrowseRouteSource).not.toContain('layout="toggle"');
    expect(workdirBrowseRouteSource).toContain('reportAgentIslandVisibility={!railCollapse.collapsed}');
  });

  it('uses a request id so repeated jumps to the same message re-run focus', () => {
    expect(sessionViewSource).toContain('requestFocusMessage(searchJump.messageClientId)');
    expect(sessionViewSource).toContain('focusMessageRequestId={focusedMessageTarget?.requestId ?? 0}');
    expect(messageStreamSource).toContain('focusMessageRequestId?: number;');
    expect(messageStreamSource).toContain('lastAppliedFocusRef.current === focusRequestKey');
    expect(messageStreamSource).toContain('missingFocus.requestKey === focusRequestKey');
  });
});
