import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { readTeammateTasks } from '@/session/readTeammateTasks';
import { resolveEffectiveConnectionError } from '@/components/connectionBannerVisibility';
import {
  resolveSessionMessageEmptyState,
  type SessionMessageEmptyStateInput,
  shouldSuppressEmptyMessageState,
  shouldSuppressRemoteListEmptyState,
} from '@/session/sessionEmptyState';
import { HistoryViewController } from '@cindy/maker-shared/message-window';
import zhMessages from '@/i18n/locales/zh-CN/message.json';

// Run the real detail-page sync callback without loading native navigation.
// Existing policy tests cannot detect an old active/archive response publishing
// a false successful-empty result. Deferred reads cover that timing in unit tier.
const detailSource = ts.createSourceFile('detail.tsx', readFileSync(
  resolve(process.cwd(), 'app/devices/[deviceId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let syncCode = '';
const presentation = new Map<string, string>();
const pendingPlaceholders: string[] = [];
function compileExpression(expression: ts.Expression) {
  return ts.transpileModule(`const result = ${expression.getText(detailSource)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText + '\nreturn result;';
}
function findSync(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer
    && ['effectiveError', 'suppressListEmptyState'].includes(node.name.getText(detailSource))) {
    presentation.set(node.name.getText(detailSource), compileExpression(node.initializer));
  }
  if (ts.isJsxAttribute(node) && node.name.getText(detailSource) === 'ListEmptyComponent'
    && node.initializer && ts.isJsxExpression(node.initializer)
    && node.initializer.expression && ts.isConditionalExpression(node.initializer.expression)) {
    pendingPlaceholders.push(compileExpression(node.initializer.expression.whenTrue));
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(detailSource) === 'syncSessions'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    syncCode = ts.transpileModule(`const sync = ${node.initializer.arguments[0].getText(detailSource)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  ts.forEachChild(node, findSync);
}
findSync(detailSource);

// PR #6381: the banner expires DEVICE_UNRESPONSIVE after recovery, while all
// three list modes still hid feedback using the raw error. Existing policy
// tests did not exercise those render branches. Unit: execute their real JSX
// expressions through failure → recovery, with a previously synced empty list.
it('uses the same effective failure for empty-state suppression and every pending placeholder', () => {
  const bindings: Record<string, unknown> = {
    error: '[DEVICE_UNRESPONSIVE] circuit open', deviceUnresponsive: true,
    resolveEffectiveConnectionError, shouldSuppressRemoteListEmptyState,
    syncedListQueryScope: 'current', listQueryScope: 'current', loading: false,
    indexedSearch: { status: 'idle' }, React, RemoteListSyncingPlaceholder: 'syncing',
  };
  const evaluate = (code: string) => new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  for (const recovering of [true, false]) {
    bindings.deviceUnresponsive = recovering;
    bindings.effectiveError = evaluate(presentation.get('effectiveError')!);
    expect(evaluate(presentation.get('suppressListEmptyState')!)).toBe(recovering);
    for (const code of pendingPlaceholders) {
      const element = evaluate(code);
      expect(element === null).toBe(recovering);
      if (element) expect(element.type).toBe('syncing');
    }
  }
});

it.each(['resolve', 'reject'])('keeps a new filter pending when the old request settles with %s', async (outcome) => {
  const firstScope = { deviceId: 'mac', filter: 'active' };
  const listQueryScopeRef = { current: firstScope };
  let finish!: (rows: unknown[]) => void;
  let fail!: (error: Error) => void;
  const invoke = vi.fn((_device: string, channel: string) => channel === 'local-db:sessions:list'
    ? new Promise<unknown[]>((yes, no) => { finish = yes; fail = no; })
    : Promise.resolve(channel === 'local-db:history:query'
      ? { ok: true, sessions: [] } : { collectionId: 'teammates', items: [] }));
  const published: unknown[][] = [];
  let syncedScope: unknown = null;
  let loading = false;
  let error: unknown = null;
  const compile = (listQueryScope: typeof firstScope) => {
    const bindings = {
      deviceId: 'mac', deviceName: 'Mac', listQueryScope, listQueryScopeRef,
      getMobileAuthOwner, isMobileAuthOwnerCurrent, readTeammateTasks,
      requestedListFilter: listQueryScope.filter, automationScopeKey: null, statusFilter: listQueryScope.filter,
      remoteListStatusFilter: (filter: string) => filter,
      LIST_LIMIT: 200, invoke, subscribe: async () => undefined,
      withTransientRemoteRetry: (read: () => Promise<unknown>) => read(),
      remoteSessionStore: {
        getHomeSessions: () => [],
        captureDeviceSessionListMutationEpoch: () => 0,
        isDeviceSessionListMutationEpochCurrent: () => true,
        // The real store coalesces identical preliminary/final snapshots.
        // Any stale first publication still reaches the assertion below.
        setDeviceSessions: (_id: string, _name: string, rows: unknown[]) => {
          if (JSON.stringify(published.at(-1)) !== JSON.stringify(rows)) published.push(rows);
        },
      },
      remoteScheduleEventStore: { clearDeviceMirrorInvalidation: () => undefined },
      invalidateOfflineScheduleIndexFailureFor: () => undefined,
      getScheduleIndexInvalidationVersion: () => 0,
      loadSharedSessionScheduleIndex: async () => new Map(), maker: {}, canLoadScheduleIndex: () => true,
      setScheduleIndex: () => undefined, setLastSyncedAt: () => undefined,
      setSyncedListQueryScope: (value: unknown) => { syncedScope = value; },
      setLoading: (value: boolean) => { loading = value; },
      setError: (value: unknown) => { error = value; }, formatRemoteError: String,
    };
    return new Function(...Object.keys(bindings), `${syncCode}\nreturn sync;`)(...Object.values(bindings)) as () => Promise<void>;
  };
  const oldRun = compile(firstScope)();
  await Promise.resolve();
  // A → archived → A is still a new query; equality of filter text is insufficient.
  listQueryScopeRef.current = { deviceId: 'mac', filter: 'archived' };
  listQueryScopeRef.current = { ...firstScope };
  if (outcome === 'resolve') finish([]); else fail(new Error('old failure'));
  await oldRun;
  expect(published).toEqual([]);
  expect(syncedScope).toBeNull();
  expect(error).toBeNull();
  expect(loading).toBe(true);

  const currentRun = compile(listQueryScopeRef.current)();
  await Promise.resolve();
  finish([]);
  await currentRun;
  expect(published).toEqual([[]]);
  expect(syncedScope).toBe(listQueryScopeRef.current);
  expect(loading).toBe(false);
  expect(shouldSuppressRemoteListEmptyState({
    itemCount: 0, hasSyncedThisOpen: syncedScope === listQueryScopeRef.current, loading,
  })).toBe(false);
});

const base = {
  loading: false,
  showSyncingShell: false,
  messageCount: 0,
  hasSyncedThisOpen: false,
  remoteUnavailable: false,
};

// #6519 / #6527, unit: these presentation cases import the screen's production
// selector directly. Legacy page callback fixtures could not exercise a restored
// empty cache without also extracting unrelated screen source.
describe('session message empty presentation', () => {
  const input: SessionMessageEmptyStateInput = {
    subscriptionIdentity: JSON.stringify(['d1', 's1', 1]), historyRead: null,
    historySnapshot: { ready: false, items: [] }, messageCount: 0,
    loading: false, showSyncingShell: false, remoteUnavailableReason: null,
    status: 'online', targetAvailable: true,
    historyNotCachedMessage: zhMessages.renderer.historyNotCached,
  };

  it('explains uncached offline history immediately', () => {
    expect(resolveSessionMessageEmptyState({ ...input, status: 'stopped' })).toEqual({
      syncingWhileEmpty: false, emptyMessage: '历史消息尚未缓存，连接电脑后同步',
    });
  });

  it('honors an empty restored history cache on an offline cold reopen', async () => {
    const view = new HistoryViewController({
      page: async () => ({ version: 1 as const, items: [], hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    view.setNetworkAvailable(false);
    await view.restoreCachedView(async () => ({ ...view.getSnapshot(), ready: true }));
    expect(resolveSessionMessageEmptyState({ ...input, status: 'stopped', historySnapshot: view.getSnapshot() }))
      .toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
  });

  it.each([
    { status: 'connecting', presence: null, syncing: true, copy: undefined },
    { status: 'online', presence: false, syncing: false, copy: '历史消息尚未缓存，连接电脑后同步' },
  ] as const)('distinguishes $status with presence=$presence from confirmed unavailability', ({ status, presence, syncing, copy }) => {
    expect(resolveSessionMessageEmptyState({ ...input, status, targetAvailable: presence }))
      .toEqual({ syncingWhileEmpty: syncing, emptyMessage: copy });
  });
});

describe('shouldSuppressEmptyMessageState', () => {
  it('suppresses the empty state on cold open before the first sync (0 msgs, not synced, online)', () => {
    // 冷开首帧:currentSession 立即有、消息未到、loading 还没翻 true → 抑制,渲染同步占位而非闪"暂无消息"。
    expect(shouldSuppressEmptyMessageState(base)).toBe(true);
  });

  it('shows the empty state once a sync completed and the session is genuinely empty', () => {
    // 真·空会话:同步完成过(lastSyncedAt 有值)且 0 条 → 不抑制,正常显示"暂无消息"。
    expect(shouldSuppressEmptyMessageState({ ...base, hasSyncedThisOpen: true })).toBe(false);
  });

  it('does not suppress when there is content', () => {
    expect(shouldSuppressEmptyMessageState({ ...base, messageCount: 80 })).toBe(false);
    expect(shouldSuppressEmptyMessageState({ ...base, messageCount: 80, hasSyncedThisOpen: true })).toBe(false);
  });

  it('does not suppress when remote is unavailable (offline / revoked keeps the placeholder)', () => {
    expect(shouldSuppressEmptyMessageState({ ...base, remoteUnavailable: true })).toBe(false);
  });

  it('suppresses while loading or showing the syncing shell regardless of other flags', () => {
    expect(shouldSuppressEmptyMessageState({ ...base, loading: true, hasSyncedThisOpen: true })).toBe(true);
    expect(shouldSuppressEmptyMessageState({ ...base, showSyncingShell: true, hasSyncedThisOpen: true })).toBe(true);
    // loading 优先于离线占位:loading 期间本就在拉取,空状态仍抑制。
    expect(shouldSuppressEmptyMessageState({ ...base, loading: true, remoteUnavailable: true })).toBe(true);
  });
});

describe('shouldSuppressRemoteListEmptyState', () => {
  // Regression: reopening an already-synced list with a new filter used to show
  // "no tasks" while its request was pending, and again when that request failed.
  // Unit tier: the production presentation policy had only cold-open coverage.
  it.each([{ loading: true }, { failed: true }])('does not report an empty result during %o', (state) => {
    expect(shouldSuppressRemoteListEmptyState({
      itemCount: 0, hasSyncedThisOpen: true, ...state,
    })).toBe(true);
    expect(shouldSuppressRemoteListEmptyState({
      itemCount: 3, hasSyncedThisOpen: true, ...state,
    })).toBe(false);
  });

  it('suppresses the empty state on cold open before the first sync completes (0 items, not synced)', () => {
    // 冷进首帧:列表初始 []、lastSyncedAt === null → 抑制,渲染干净空白而非闪"暂无自动化/还没有对话"。
    expect(shouldSuppressRemoteListEmptyState({ itemCount: 0, hasSyncedThisOpen: false })).toBe(true);
  });

  it('shows the empty state once a sync completed and the list is genuinely empty', () => {
    // 真·空列表:首同步完成过(lastSyncedAt 有值)且确实 0 条 → 不抑制,正常显示空状态插画。
    expect(shouldSuppressRemoteListEmptyState({ itemCount: 0, hasSyncedThisOpen: true })).toBe(false);
  });

  it('never suppresses when the list has content (store pre-seeded before the first sync)', () => {
    // 从首页带 store 数据进入:同步尚未完成但列表已有内容 → 空状态本就不渲染,判定恒为不抑制。
    expect(shouldSuppressRemoteListEmptyState({ itemCount: 3, hasSyncedThisOpen: false })).toBe(false);
    expect(shouldSuppressRemoteListEmptyState({ itemCount: 3, hasSyncedThisOpen: true })).toBe(false);
  });
});
