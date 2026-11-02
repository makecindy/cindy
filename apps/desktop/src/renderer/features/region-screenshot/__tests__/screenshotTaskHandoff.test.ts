import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerDraft } from '@/lib/composerDraftStore';
import type { RegionScreenshotComposeRequest } from '../../../../shared/regionScreenshot';

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
import { getDraft, saveDraft, clearDraft, discardDraft, setComposerDraftOwner } from '@/lib/composerDraftStore';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
const drafts = {
  get current() { return getDraft(NEW_MAKER_DRAFT_KEY); },
  set current(value: ComposerDraft | undefined) {
    if (value) saveDraft(NEW_MAKER_DRAFT_KEY, value);
    else clearDraft(NEW_MAKER_DRAFT_KEY);
  },
};
import { applyScreenshotComposeRequest } from '../screenshotTaskHandoff';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { takeComposerSubmitRequest } from '@/lib/composerActionsBus';

const original: ComposerDraft = {
  text: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'my original draft' }] }],
  },
  attachments: [],
};
const request = (id: string, action = 'translate'): RegionScreenshotComposeRequest => ({
  id,
  ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
  action: action as RegionScreenshotComposeRequest['action'],
  url: `image:${id}`,
  filename: `${id}.png`,
  bytes: 16,
  width: 2,
  height: 2,
});

// 测试价值：生产 applyScreenshotComposeRequest 保护连续 AI 操作和恢复期间的新输入。
// 既有 bus 测试只验证一次性消费，不验证草稿；最小失败输入为两次动作、清空、推进 500ms。
// tier: unit，使用真实进程内草稿存储；不启动编辑器或真实发送。
describe('screenshot draft restoration', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { electronAPI: { cindyMediaStorage: { reportDraftUrls: vi.fn() } } });
    setDataOwnerGeneration('owner-a', 1);
    setComposerDraftOwner('owner-a');
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await vi.runAllTimersAsync();
    takeComposerSubmitRequest(NEW_MAKER_DRAFT_KEY);
    vi.useRealTimers();
    drafts.current = undefined;
    setComposerDraftOwner('owner-a');
    clearDraft(NEW_MAKER_DRAFT_KEY);
    vi.unstubAllGlobals();
  });
  it('retains the original draft across consecutive quick actions', async () => {
    vi.useFakeTimers();
    drafts.current = original;
    applyScreenshotComposeRequest(request('a'), vi.fn());
    applyScreenshotComposeRequest(request('b'), vi.fn());
    await vi.advanceTimersByTimeAsync(500);
    drafts.current = undefined;
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.stringify(drafts.current)).toContain('my original draft');
  });
  it('merges the original with text entered after a successful send', async () => {
    vi.useFakeTimers();
    drafts.current = original;
    applyScreenshotComposeRequest(request('c'), vi.fn());
    drafts.current = {
      text: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new typing' }] }],
      },
      attachments: [],
    };
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.stringify(drafts.current)).toContain('my original draft');
    expect(JSON.stringify(drafts.current)).toContain('new typing');
  });
  it('preserves ask attachments alongside an outstanding automatic action', async () => {
    vi.useFakeTimers();
    drafts.current = original;
    applyScreenshotComposeRequest(request('d'), vi.fn());
    applyScreenshotComposeRequest(request('e', 'ask'), vi.fn());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(JSON.stringify(drafts.current)).toContain('my original draft');
    expect(drafts.current?.attachments.map((file) => file.url)).toEqual(['image:d', 'image:e']);
    expect(takeComposerSubmitRequest(NEW_MAKER_DRAFT_KEY)).toBeNull();
  });
  // Unit: same-owner generation bumps retain drafts; account switches restore only
  // the captured namespace. Real draft storage also protects explicitly discarded input.
  it.each(['generation', 'account', 'discard'] as const)('preserves recovery boundaries after %s', async (change) => {
    drafts.current = original;
    applyScreenshotComposeRequest(request('recovery'), vi.fn());
    if (change === 'account') {
      setDataOwnerGeneration('owner-b', 2);
      setComposerDraftOwner('owner-b');
      drafts.current = { text: null, attachments: [] };
    } else if (change === 'discard') discardDraft(NEW_MAKER_DRAFT_KEY);
    else {
      setDataOwnerGeneration('owner-a', 2);
      clearDraft(NEW_MAKER_DRAFT_KEY);
    }
    await vi.advanceTimersByTimeAsync(500);
    if (change === 'account') {
      expect(drafts.current).toEqual({ text: null, attachments: [] });
      clearDraft(NEW_MAKER_DRAFT_KEY);
      setComposerDraftOwner('owner-a');
    }
    if (change === 'discard') expect(drafts.current).toBeUndefined();
    else expect(JSON.stringify(drafts.current)).toContain('my original draft');
  });
  it('drops a taken screenshot delivered after the renderer owner changes', () => {
    drafts.current = original;
    setDataOwnerGeneration('owner-b', 2);
    const navigate = vi.fn();
    applyScreenshotComposeRequest(request('stale'), navigate);
    expect(drafts.current).toEqual(original);
    expect(navigate).not.toHaveBeenCalled();
    expect(takeComposerSubmitRequest(NEW_MAKER_DRAFT_KEY)).toBeNull();
  });
});
