// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createElement, useCallback, useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import { BOT_GROUP_LANE_SESSION, findSessionNotificationSession, isBackgroundTaskNotificationTarget } from '@/lib/sessionEventNotification';
import { isReviewSessionSource } from '../../../../shared/sessionSource';
import {
  formatOrcaWorkerNotificationTitle,
  shouldNotifyOrcaWorkerEvent,
} from '../lib/orcaLeadWorkerAttention';

const source = ts.createSourceFile('sidebar.tsx', readFileSync(resolve(
  process.cwd(), 'src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx',
), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const expanded = source.statements.find((statement): statement is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'ExpandedView',
)!;
const declarationNames = new Set([
  'sessions', 'visibleRemoteSessionsForNotification', 'sessionsRef',
  'allSessionsForNotificationRef', 'remoteSessionsForNotificationRef',
  'unnamedLabelRef', 'fireSessionNotification',
]);
const refNames = new Set([
  'sessionsRef', 'allSessionsForNotificationRef', 'remoteSessionsForNotificationRef', 'unnamedLabelRef',
]);
const statements = expanded.body!.statements.filter(statement => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declarationNames.has(declaration.name.text),
    );
  }
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false;
  const target = statement.expression.left;
  return ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)
    && refNames.has(target.expression.text);
});
const emitted = ts.transpileModule(
  statements.map(statement => statement.getText(source)).join('\n') + '\nreturn fireSessionNotification;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

// PR #6196: helper tests cover receipt routing, but cannot catch the sidebar
// forgetting to call it. Reuse this component's parsed source and run its actual
// route/focus effects and row-click callback with React, not source assertions.
const attentionStatements = expanded.body!.statements.filter(statement => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === 'handleSessionClick',
    );
  }
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'useEffect') return false;
  const dependencies = call.arguments[1];
  if (!dependencies || !ts.isArrayLiteralExpression(dependencies)) return false;
  const names = dependencies.elements.map(dependency => dependency.getText(source));
  return names.includes('activeRemoteAttentionRev')
    || names.length === 1 && names[0] === 'viewedSessionId';
});
if (attentionStatements.length !== 3) throw new Error('Missing production sidebar attention consumers');
const attentionCode = ts.transpileModule(
  attentionStatements.map(statement => statement.getText(source)).join('\n')
    .replaceAll('import.meta', 'importMeta'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function attentionSidebar() {
  const clearAttention = vi.fn();
  const bindings = {
    useCallback, useEffect, window,
    activeSessionRemoteReceiptKey: undefined, activeRemoteAttentionRev: 0,
    markAutomationSessionRunsRead: vi.fn(), clearSystemSessionAttention: clearAttention,
    hasSessionSelectionModifier: () => false,
    selectedSessionIdsRef: { current: new Set<string>() }, setSelectedSessionIds: vi.fn(),
    setSelectionAnchorSessionId: vi.fn(), urgentSetRef: { current: new Set<string>() },
    attentionKindsRef: { current: new Map() }, sessionsByIdRef: { current: new Map() },
    runningSessionIdsRef: { current: new Set() }, sidebarNotificationsRef: { current: new Set() },
    holdSidebarViewedPriority: vi.fn(), sidebarPriorityContext: (context: unknown) => context,
    clearNotification: vi.fn(), activeSessionIdRef: { current: 'shown' },
    navigate: vi.fn(), resolveSessionRoute: async () => '/cc-agent/clicked',
    importMeta: { env: { DEV: false } }, perfLog: { debug: vi.fn() },
  };
  const consume = new Function(...Object.keys(bindings), 'viewedSessionId',
    attentionCode + '\nreturn handleSessionClick;') as (...args: unknown[]) => (id: string) => void;
  function SidebarAttention({ viewedSessionId, clickedSessionId = 'clicked' }: { viewedSessionId: string | null; clickedSessionId?: string }) {
    const onSessionClick = consume(...Object.values(bindings), viewedSessionId);
    // The row is a DOM boundary adapter; its callback and both effects above are
    // the production ExpandedView code. Receipt payloads stay in helper tests.
    return createElement('button', { onClick: () => onSessionClick(clickedSessionId) }, 'Open task');
  }
  return { Component: SidebarAttention, clearAttention };
}

type NotificationSession = {
  id: string;
  title: string;
  source: string;
  status?: 'active' | 'archived';
  deviceLinkDeviceId?: string;
  hiddenAt?: string | null;
  orcaRole?: 'lead' | 'worker';
};
const send = vi.fn();
const reviewTarget = vi.fn(async () => false);
const botTitle = vi.fn(async (): Promise<string | null> => null);
const leadOfWorker = vi.fn<(workerSessionId: string) => string | null>(() => null);
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

function dispatcher(local: NotificationSession[], remote: NotificationSession[] = []) {
  const bindings = {
    useMemo: (factory: () => unknown) => factory(),
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
    sessionsHook: { sessions: local.filter(session => session.status !== 'archived') },
    allSessionsForAttention: local.filter(session => !isCindyMakeSource(session.source)),
    allSessionsForNotification: local,
    remoteSessionsForNotification: remote,
    CINDY_MAKE_ENABLED: false,
    isCindyMakeSource,
    findSessionNotificationSession,
    isOrcaWorkerSession,
    isReviewSessionSource,
    projectDraftSessionTitle,
    sendSessionEventNotification: send,
    isReviewSessionNotificationTarget: reviewTarget,
    isBackgroundTaskNotificationTarget,
    botOwnedSessionNotificationTitle: botTitle,
    BOT_GROUP_LANE_SESSION,
    shouldNotifyOrcaWorkerEvent,
    formatOrcaWorkerNotificationTitle,
    findOrcaLeadSessionIdForWorker: leadOfWorker,
    t: () => 'Unnamed task',
  };
  return new Function(...Object.keys(bindings), emitted)(...Object.values(bindings)) as (
    sessionId: string, kind: 'done' | 'error' | 'needs-reply',
    options?: { inputHandoff: true; inputHandoffRequestId: string },
  ) => void;
}

describe('disabled Make notification dispatch', () => {
  // #6754 / unit: run the production sidebar callback to protect the event ID
  // through each local dispatch branch, including the async hidden-bot fallback.
  it.each(['ordinary', 'worker', 'unknown'] as const)('forwards handoff request identity for %s tasks', async route => {
    const options = { inputHandoff: true as const, inputHandoffRequestId: 'request-1' };
    const fire = dispatcher(route === 'unknown' ? [] : [{
      id: route, title: 'Task', source: 'desktop',
      ...(route === 'worker' ? { orcaRole: 'worker' as const } : {}),
    }]);
    fire(route, 'needs-reply', options);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledExactlyOnceWith(route, expect.any(String), 'needs-reply', expect.objectContaining(options));
  });

  it.each(['cindy-make', 'cindy-make-merge'].flatMap(source =>
    (['local', 'archived', 'remote'] as const).flatMap(location =>
      (['done', 'error', 'needs-reply'] as const).map(kind => ({ source, location, kind })),
    ),
  ))('suppresses $kind for $location $source metadata omitted from UI lists', async ({ source, location, kind }) => {
    const session: NotificationSession = {
      id: 'hidden', title: 'Hidden Make task', source,
      status: location === 'archived' ? 'archived' : 'active',
      ...(location === 'remote' ? { deviceLinkDeviceId: 'host' } : {}),
    };
    const fire = dispatcher(location === 'remote' ? [] : [session], location === 'remote' ? [session] : []);
    fire('hidden', kind);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(reviewTarget).not.toHaveBeenCalled();
    expect(botTitle).not.toHaveBeenCalled();
  });

  it('keeps ordinary local and remote notifications', () => {
    dispatcher([{ id: 'ordinary', title: 'Ordinary task', source: 'desktop' }])('ordinary', 'done');
    expect(send).toHaveBeenCalledWith('ordinary', 'Ordinary task', 'done', {
      remoteDevice: false, remoteDeviceId: undefined,
    });
    dispatcher([], [{ id: 'remote', title: 'Remote task', source: 'desktop', deviceLinkDeviceId: 'host' }])('remote', 'needs-reply');
    expect(send).toHaveBeenCalledWith('remote', 'Remote task', 'needs-reply', {
      remoteDevice: true, remoteDeviceId: 'host',
    });
  });

  it('suppresses plugin background tasks and notifies again once they are shown', () => {
    dispatcher([{ id: 'bg', title: 'Background', source: 'plugin', hiddenAt: '2026-10-15T00:00:00.000Z' }])('bg', 'done');
    expect(send).not.toHaveBeenCalled();
    expect(reviewTarget).not.toHaveBeenCalled();
    dispatcher([{ id: 'bg', title: 'Background', source: 'plugin', hiddenAt: null }])('bg', 'done');
    expect(send).toHaveBeenCalledWith('bg', 'Background', 'done', { remoteDevice: false, remoteDeviceId: undefined });
  });

  it('preserves the unknown-task fallback', async () => {
    dispatcher([])('unknown', 'error');
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith('unknown', 'Unnamed task', 'error');
  });
});

describe('sidebar system attention consumers', () => {
  it('clears the viewed task on opening and window focus, replacing and removing its focus listener', () => {
    const { Component, clearAttention } = attentionSidebar();
    const view = render(createElement(Component, { viewedSessionId: 'first' }));
    expect(clearAttention.mock.calls).toEqual([['first']]);
    fireEvent(window, new Event('focus'));
    expect(clearAttention.mock.calls).toEqual([['first'], ['first']]);

    view.rerender(createElement(Component, { viewedSessionId: 'second' }));
    clearAttention.mockClear();
    fireEvent(window, new Event('focus'));
    expect(clearAttention.mock.calls).toEqual([['second']]);

    view.rerender(createElement(Component, { viewedSessionId: null }));
    clearAttention.mockClear();
    fireEvent(window, new Event('focus'));
    expect(clearAttention).not.toHaveBeenCalled();
    view.rerender(createElement(Component, { viewedSessionId: 'third' }));
    clearAttention.mockClear();
    view.unmount();
    fireEvent(window, new Event('focus'));
    expect(clearAttention).not.toHaveBeenCalled();
  });

  it('clears the clicked task, including re-opening the already active task', async () => {
    const { Component, clearAttention } = attentionSidebar();
    const view = render(createElement(Component, { viewedSessionId: 'shown' }));
    clearAttention.mockClear();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open task' })));
    expect(clearAttention.mock.calls).toEqual([['clicked']]);

    view.rerender(createElement(Component, { viewedSessionId: 'shown', clickedSessionId: 'shown' }));
    clearAttention.mockClear();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open task' })));
    expect(clearAttention.mock.calls).toEqual([['shown']]);
  });
});

describe('Orca Worker notification dispatch', () => {
  const lead: NotificationSession = { id: 'lead', title: '重构登录', source: 'desktop', orcaRole: 'lead' };
  const worker: NotificationSession = {
    id: 'worker', title: 'Worker · developer', source: 'desktop', orcaRole: 'worker',
  };

  it('Worker 的完成仍不单独通知', () => {
    leadOfWorker.mockReturnValue('lead');
    dispatcher([lead, worker])('worker', 'done');
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['error', 'needs-reply'] as const)('Worker 的 %s 以「Lead 标题 · Worker 标题」单独通知', (kind) => {
    leadOfWorker.mockReturnValue('lead');
    dispatcher([lead, worker])('worker', kind);
    expect(leadOfWorker).toHaveBeenCalledWith('worker');
    expect(send).toHaveBeenCalledWith('worker', '重构登录 · Worker · developer', kind);
  });

  it('找不到 Lead 时退回 Worker 标题', () => {
    leadOfWorker.mockReturnValue(null);
    dispatcher([worker])('worker', 'error');
    expect(send).toHaveBeenCalledWith('worker', 'Worker · developer', 'error');
  });

  it('远程控制另一台电脑的 Worker 不在范围内', () => {
    leadOfWorker.mockReturnValue('lead');
    dispatcher([], [{ ...worker, deviceLinkDeviceId: 'host' }])('worker', 'error');
    expect(send).not.toHaveBeenCalled();
  });
});
