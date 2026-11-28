import { describe, expect, it, vi } from 'vitest';
import {
  createMobileVoiceDictionaryLearningTracker,
} from '@/session/mobileVoiceDictionaryLearning';

describe('mobileVoiceDictionaryLearning', () => {
  it('submits edited refined voice text after the desktop-style quiet window', () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const tracker = createMobileVoiceDictionaryLearningTracker({
      submit,
      timeoutMs: 1000,
    });

    tracker.captureRefinedInsertion({
      draft: 'prefix XDMaker suffix',
      rawTranscriptText: 'xd maker',
      refinedText: 'XDMaker',
      start: 7,
      end: 14,
      uiLanguage: 'zh-CN',
      sourceLanguage: 'zh-CN',
    });
    tracker.inspectDraft('prefix XDMaker App suffix');

    expect(submit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(submit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(submit).toHaveBeenCalledWith({
      source: 'mobile',
      rawTranscriptText: 'xd maker',
      beforeText: 'XDMaker',
      afterText: 'XDMaker App',
      context: {
        uiLanguage: 'zh-CN',
        sourceLanguage: 'zh-CN',
        selectionBefore: 'prefix',
        selectionAfter: 'suffix',
      },
    });
    vi.useRealTimers();
  });

  it('flushes pending evidence immediately when the user sends before the quiet window', () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const tracker = createMobileVoiceDictionaryLearningTracker({
      submit,
      timeoutMs: 1000,
    });

    tracker.captureRefinedInsertion({
      draft: 'Open claw',
      rawTranscriptText: 'open claw',
      refinedText: 'Open claw',
      start: 0,
      end: 9,
    });
    tracker.inspectDraft('OpenClaw');
    tracker.flush();
    vi.advanceTimersByTime(1000);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      beforeText: 'Open claw',
      afterText: 'OpenClaw',
    }));
    vi.useRealTimers();
  });

  it('drops the watch when surrounding draft text changes because mobile lacks editor transaction mapping', () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const tracker = createMobileVoiceDictionaryLearningTracker({
      submit,
      timeoutMs: 1000,
    });

    tracker.captureRefinedInsertion({
      draft: 'before XDMaker after',
      rawTranscriptText: 'xd maker',
      refinedText: 'XDMaker',
      start: 7,
      end: 14,
    });
    tracker.inspectDraft('changed before XDMaker after');
    vi.advanceTimersByTime(1000);

    expect(submit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // 测试价值：验证移动端点击“还原原文”调用 noteRefinementUndone 后，不会把“润色后 -> 原文”误学进词典，且后续用户对原文的手动纠错仍能被正常学习。
  // 依据：语音输入优化 ⑧ 要求应用内撤销润色退回原文不产生脏词典学习记录。
  // 缺口：既有 mobileVoiceDictionaryLearning 用例未覆盖 noteRefinementUndone 状态重锚。
  // 最小输入：captureRefinedInsertion -> noteRefinementUndone -> 静默期满（零提交）-> 手动改字 -> 正常提交。
  // tier: unit，假时钟纯内存测试，耗时 <10ms。
  it('discards refined-to-raw undo from dictionary learning and still learns later manual edits on the raw text', () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const tracker = createMobileVoiceDictionaryLearningTracker({
      submit,
      timeoutMs: 1000,
    });

    tracker.captureRefinedInsertion({
      draft: '请看 XDMaker 文档',
      rawTranscriptText: 'xd maker',
      refinedText: 'XDMaker',
      start: 3,
      end: 10,
      uiLanguage: 'zh-CN',
      sourceLanguage: 'zh-CN',
    });
    tracker.noteRefinementUndone({
      draft: '请看 xd maker 文档',
      start: 3,
      end: 11,
      rawTranscriptText: 'xd maker',
    });
    tracker.inspectDraft('请看 xd maker 文档');
    vi.advanceTimersByTime(1000);
    expect(submit).not.toHaveBeenCalled();

    // User subsequently fixes the raw text manually; that edit IS learned cleanly.
    tracker.inspectDraft('请看 Cindy 文档');
    vi.advanceTimersByTime(1000);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'mobile',
      rawTranscriptText: 'xd maker',
      beforeText: 'xd maker',
      afterText: 'Cindy',
    }));
    vi.useRealTimers();
  });
});
