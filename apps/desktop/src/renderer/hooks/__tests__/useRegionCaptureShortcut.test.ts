import { readFileSync } from 'node:fs';
import { getDataOwnerGeneration, setDataOwnerGeneration, isDataOwnerIdCurrent, isDataOwnerGenerationCurrent, __testing as ownerTesting } from '../../contexts/dataOwnerGeneration';
import { describe, expect, it, vi } from 'vitest';
import { createComposerDraftSaveScheduler } from '../../lib/composerDraftSaveScheduler';
import { getDraft, saveDraft, subscribeDraft, plainTextToTiptapDoc } from '../../lib/composerDraftStore';

import { NEW_MAKER_DRAFT_KEY } from '../../features/cc-agent/newMakerDraftKeys';
import {
  appendRegionCaptureToDraft,
  resolveRegionCaptureComposer,
  registerRegionCaptureRouteOwner,
  registerComposerCaptureDraftFlusher,
  getComposerCaptureLockVersion,
  isComposerCaptureLocked,
  registerComposerCaptureLock,
  subscribeComposerCaptureLocks,
  requestRegionCapture,
  resolveRegionCaptureTargetFromPath,
} from '../useRegionCaptureShortcut';

describe('composer capture lock registry', () => {
  // 同一 draftKey 多实例挂载(分屏同会话): 任一实例仍锁定即视为锁定;
  // 解锁按 token 对称, 不误清其它实例的锁。
  it('tracks per-draftKey locks with multi-mount tokens', () => {
    expect(isComposerCaptureLocked('s1')).toBe(false);
    const releaseA = registerComposerCaptureLock('s1');
    const releaseB = registerComposerCaptureLock('s1');
    expect(isComposerCaptureLocked('s1')).toBe(true);
    releaseA();
    expect(isComposerCaptureLocked('s1')).toBe(true);
    releaseB();
    expect(isComposerCaptureLocked('s1')).toBe(false);
    // release 幂等
    releaseB();
    expect(isComposerCaptureLocked('s1')).toBe(false);
    expect(isComposerCaptureLocked('s2')).toBe(false);
  });

  // 锁变更要可订阅: guest 转发的可用性上报随锁变化重报, 否则锁定期间
  // main 仍拦 webview 按键(review P2)。幂等 release 不产生通知。
  it('notifies subscribers on lock changes and bumps the version', () => {
    let notified = 0;
    const unsubscribe = subscribeComposerCaptureLocks(() => {
      notified += 1;
    });
    const before = getComposerCaptureLockVersion();
    const release = registerComposerCaptureLock('s3');
    expect(notified).toBe(1);
    release();
    expect(notified).toBe(2);
    release();
    expect(notified).toBe(2);
    expect(getComposerCaptureLockVersion()).toBe(before + 2);
    unsubscribe();
    registerComposerCaptureLock('s3');
    expect(notified).toBe(2);
  });
});

describe('requestRegionCapture', () => {
  // composer「+」菜单入口在 MainLayout 未注册 trigger 时(理论不可达)安全
  // 返回 false, 不抛错。注册后的行为与快捷键共用同一 trigger, 由 MainLayout
  // 单点注册保证。
  it('safely returns false when no trigger is registered', () => {
    expect(requestRegionCapture()).toBe(false);
  });
});

describe('resolveRegionCaptureTargetFromPath', () => {
  it('session route → that session (draft key = session id)', () => {
    expect(resolveRegionCaptureTargetFromPath('/cc-agent/abc-123')).toEqual({
      sessionId: 'abc-123',
      draftKey: 'abc-123',
    });
  });

  it('new-maker draft route → NEW_MAKER_DRAFT_KEY, no session id (base64 attachment path)', () => {
    expect(resolveRegionCaptureTargetFromPath('/cc-agent/new')).toEqual({
      sessionId: null,
      draftKey: NEW_MAKER_DRAFT_KEY,
    });
  });

  // 无主内容区 composer 的路由不消费按键(触发端据 null 返回 false, 按键保持
  // 原生行为)。files 段是文档浏览(rail composer 不作为目标, 归属对用户不可
  // 预期); boot/new-dialogue/scheduled 是非会话段。
  it('routes without a main-area composer → null', () => {
    for (const pathname of [
      '/settings',
      '/issues',
      '/cc-agent/files/some-doc',
      '/cc-agent/boot',
      '/cc-agent/new-dialogue',
      '/cc-agent/scheduled',
      '/cc-agent/orca/some-lead',
      '/',
    ]) {
      expect(resolveRegionCaptureTargetFromPath(pathname)).toBeNull();
    }
  });
});


describe('capture pending editor save', () => {
  it('merges after cache completion using the live pending document', async () => {
    const key = 'capture-live-pending';
    const oldText = plainTextToTiptapDoc('before');
    const liveText = plainTextToTiptapDoc('before newly typed');
    saveDraft(key, { text: oldText, attachments: [], quotes: [] }, { silent: true });
    let resolveCache!: (value: { url: string }) => void;
    const cache = new Promise<{ url: string }>((resolve) => { resolveCache = resolve; });
    vi.stubGlobal('window', { electronAPI: { cacheImageFromBuffer: () => cache } });
    const scheduler = createComposerDraftSaveScheduler({ setTimer: () => 1, clearTimer: () => {} });
    const release = registerComposerCaptureDraftFlusher(key, scheduler.flush, () => true);
    const unrelated = vi.fn();
    const releaseOther = registerComposerCaptureDraftFlusher('other-capture-draft', unrelated, () => false);
    try {
      const pending = appendRegionCaptureToDraft({ sessionId: key, draftKey: key }, new Uint8Array([1]), () => true);
      scheduler.schedule(() => saveDraft(key, { ...getDraft(key)!, text: liveText }, { silent: true }));
      resolveCache({ url: 'xdt-image://capture.png' });
      await pending;
      expect(getDraft(key)?.text).toEqual(liveText);
      expect(getDraft(key)?.attachments).toHaveLength(1);
      expect(unrelated).not.toHaveBeenCalled();
    } finally {
      release();
      releaseOther();
      scheduler.cancel();
      vi.unstubAllGlobals();
    }
  });
});


it('does not append after a flush invalidates the target', async () => {
  const key = 'capture-invalidated';
  let valid = true;
  vi.stubGlobal('window', { electronAPI: { cacheImageFromBuffer: async () => ({ url: 'xdt-image://capture.png' }) } });
  const release = registerComposerCaptureDraftFlusher(key, () => { valid = false; }, () => true);
  try {
    await appendRegionCaptureToDraft({ sessionId: key, draftKey: key }, new Uint8Array([1]), () => valid);
    expect(getDraft(key)).toBeUndefined();
  } finally {
    release();
    vi.unstubAllGlobals();
  }
});


it.each([false, true])('does not flush a stale same-key composer (menu=%s)', async (menu) => {
  const key = `multi-capture-${menu}`;
  const targetId = Symbol('target');
  const liveText = plainTextToTiptapDoc('latest target text');
  const staleText = plainTextToTiptapDoc('stale hidden text');
  const target = vi.fn(() => saveDraft(key, { text: liveText, attachments: [], quotes: [] }, { silent: true }));
  const stale = vi.fn(() => saveDraft(key, { text: staleText, attachments: [], quotes: [] }, { silent: true }));
  const releaseTarget = registerComposerCaptureDraftFlusher(key, target, () => !menu, targetId);
  const releaseStale = registerComposerCaptureDraftFlusher(key, stale, () => menu);
  vi.stubGlobal('window', { electronAPI: { cacheImageFromBuffer: async () => ({ url: 'xdt-image://capture.png' }) } });
  try {
    await appendRegionCaptureToDraft({ sessionId: key, draftKey: key, ...(menu ? { composerId: targetId } : {}) }, new Uint8Array([1]), () => true);
    expect(target).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
    expect(getDraft(key)?.text).toEqual(liveText);
  } finally {
    releaseTarget();
    releaseStale();
    vi.unstubAllGlobals();
  }
});


it.each([false, true])('capture flusher survives same-owner refresh but rejects account switches (%s)', (switchAccount) => {
  const source = readFileSync(new URL('../../components/new-chat/ChatInput.tsx', import.meta.url), 'utf8');
  const callback = source.match(/registerComposerCaptureDraftFlusher\(storageKey, \(\) => \{([\s\S]*?)\n {4}\},/);
  expect(callback).not.toBeNull();
  setDataOwnerGeneration('capture-owner', 1);
  const owner = getDataOwnerGeneration();
  const flush = vi.fn();
  const run = new Function('storageKeyForDraftRef', 'storageKey', 'isDataOwnerIdCurrent', 'isDataOwnerGenerationCurrent', 'owner', 'draftSaveSchedulerRef', callback![1]);
  try {
    setDataOwnerGeneration(switchAccount ? 'other-owner' : 'capture-owner', 2);
    run({ current: 'draft' }, 'draft', isDataOwnerIdCurrent, isDataOwnerGenerationCurrent, owner, { current: { flush } });
    expect(flush).toHaveBeenCalledTimes(switchAccount ? 0 : 1);
    flush.mockClear();
    run({ current: 'different-draft' }, 'draft', isDataOwnerIdCurrent, isDataOwnerGenerationCurrent, owner, { current: { flush } });
    expect(flush).not.toHaveBeenCalled();
  } finally {
    ownerTesting.reset();
  }
});


it('resolves only a mounted verified Bot route owner and revokes it on unmount/account switch', () => {
  const path = '/bots/bot-a/session/session-a';
  expect(resolveRegionCaptureTargetFromPath(path)).toBeNull();
  setDataOwnerGeneration('account-a', 1);
  const release = registerRegionCaptureRouteOwner(path, 'session-a');
  expect(resolveRegionCaptureTargetFromPath(path)).toBeNull();
  const releaseComposer = registerComposerCaptureDraftFlusher('session-a', () => {}, () => true);
  try {
    expect(resolveRegionCaptureTargetFromPath(path)).toEqual({ sessionId: 'session-a', draftKey: 'session-a' });
    expect(resolveRegionCaptureTargetFromPath('/bots/bot-b/session/session-a')).toBeNull();
    expect(resolveRegionCaptureTargetFromPath('/bots/bot-a/history/session-a')).toBeNull();
    setDataOwnerGeneration('account-a', 2);
    expect(resolveRegionCaptureTargetFromPath(path)?.sessionId).toBe('session-a');
    setDataOwnerGeneration('account-b', 3);
    expect(resolveRegionCaptureTargetFromPath(path)).toBeNull();
  } finally { releaseComposer(); release(); ownerTesting.reset(); }
  expect(resolveRegionCaptureTargetFromPath(path)).toBeNull();
});


it('preserves sibling live edits through real draft notifications and their later save', () => {
  const key = 'capture-notification-siblings';
  const owner = Symbol('owner');
  const sibling = Symbol('sibling');
  let siblingDocument: ReturnType<typeof plainTextToTiptapDoc> | null = plainTextToTiptapDoc('unsaved sibling edit');
  const ownerDocument = plainTextToTiptapDoc('owner edit');
  const scheduler = createComposerDraftSaveScheduler({ setTimer: () => 1, clearTimer: () => {} });
  const applyOwner = vi.fn();
  const offOwner = subscribeDraft(key, applyOwner, { composerId: owner });
  const offSibling = subscribeDraft(key, () => { siblingDocument = getDraft(key)!.text; }, { composerId: sibling });
  scheduler.schedule(() => saveDraft(key, { text: siblingDocument, attachments: [], quotes: [] }, { silent: true }));
  try {
    saveDraft(key, { text: ownerDocument, attachments: [], quotes: [] }, { composerId: owner });
    expect(applyOwner).toHaveBeenCalledOnce();
    scheduler.flush();
    expect(getDraft(key)?.text).toEqual(plainTextToTiptapDoc('unsaved sibling edit'));
  } finally { offOwner(); offSibling(); scheduler.cancel(); }
});


it('requires a live eligible composer even on a cc-agent URL', () => {
  const target = { sessionId: 'surface-mask', draftKey: 'surface-mask' };
  expect(resolveRegionCaptureTargetFromPath('/cc-agent/surface-mask')).toEqual(target);
  expect(resolveRegionCaptureComposer(target)).toBeUndefined();
  const id = Symbol('live-composer');
  const release = registerComposerCaptureDraftFlusher(target.draftKey, () => {}, () => false, id);
  expect(resolveRegionCaptureComposer(target)?.instanceId).toBe(id);
  release();
  expect(resolveRegionCaptureComposer({ ...target, composerId: id })).toBeUndefined();
});

it('refreshes multi-composer availability on focus transitions and removes listeners', () => {
  const key = 'capture-focus-events';
  let focused = false;
  let notify: (() => void) | undefined;
  const off = vi.fn(() => { notify = undefined; });
  const release = registerComposerCaptureDraftFlusher(key, () => {}, () => focused, Symbol(), (listener) => { notify = listener; return off; });
  const sibling = registerComposerCaptureDraftFlusher(key, () => {}, () => false);
  const observed: boolean[] = [];
  const unsubscribe = subscribeComposerCaptureLocks(() => { observed.push(!!resolveRegionCaptureComposer({ sessionId: key, draftKey: key })); });
  try {
    focused = true; notify?.();
    focused = false; notify?.();
    expect(observed).toEqual([true, false]);
  } finally { unsubscribe(); release(); sibling(); }
  expect(off).toHaveBeenCalledOnce();
  expect(notify).toBeUndefined();
});

it.each([true, false])('warns only when a failed cache produces a valid fallback attachment (valid=%s)', async (valid) => {
  const key = `capture-cache-failure-${valid}`;
  const warning = vi.fn();
  vi.stubGlobal('window', { electronAPI: { cacheImageFromBuffer: async () => { throw new Error('disk full'); } } });
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,AQ==';
    onload?: () => void;
    readAsDataURL() { this.onload?.(); }
  });
  const release = registerComposerCaptureDraftFlusher(key, () => {}, () => true);
  try {
    await appendRegionCaptureToDraft({ sessionId: key, draftKey: key }, new Uint8Array([1]), () => valid, warning);
    expect(warning).toHaveBeenCalledTimes(valid ? 1 : 0);
    if (valid) expect(getDraft(key)?.attachments[0]?.base64).toBe('AQ==');
    else expect(getDraft(key)).toBeUndefined();
  } finally { release(); vi.unstubAllGlobals(); }
});
