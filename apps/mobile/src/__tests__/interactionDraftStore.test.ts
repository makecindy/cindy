import { beforeEach, describe, expect, it } from 'vitest';
import {
  askQuestionsIdentity,
  clearAllInteractionDrafts,
  clearAskUserDraft,
  clearPlanReviewDraft,
  readAskUserDraft,
  readAskUserDraftFor,
  readPlanReviewDraft,
  saveAskUserDraft,
  savePlanReviewDraft,
} from '@/session/interactionDraftStore';

describe('interactionDraftStore', () => {
  beforeEach(() => {
    clearAllInteractionDrafts();
  });

  it('stores ask-user drafts by request id and returns defensive clones', () => {
    saveAskUserDraft('req-1', {
      answers: { q1: 'Yes' },
      currentIndex: 1,
      customInput: 'partial',
      selectedLabels: ['A'],
      showCustomInput: true,
    });

    const first = readAskUserDraft('req-1');
    expect(first).toEqual({
      answers: { q1: 'Yes' },
      currentIndex: 1,
      customInput: 'partial',
      selectedLabels: ['A'],
      showCustomInput: true,
    });

    first!.answers.q1 = 'Mutated';
    first!.selectedLabels.push('B');
    expect(readAskUserDraft('req-1')).toEqual({
      answers: { q1: 'Yes' },
      currentIndex: 1,
      customInput: 'partial',
      selectedLabels: ['A'],
      showCustomInput: true,
    });
  });

  it('clears one request without touching other drafts', () => {
    saveAskUserDraft('req-1', {
      answers: {},
      currentIndex: 0,
      customInput: '',
      selectedLabels: [],
      showCustomInput: false,
    });
    saveAskUserDraft('req-2', {
      answers: { q: 'answer' },
      currentIndex: 0,
      customInput: '',
      selectedLabels: [],
      showCustomInput: false,
    });

    clearAskUserDraft('req-1');

    expect(readAskUserDraft('req-1')).toBeNull();
    expect(readAskUserDraft('req-2')?.answers).toEqual({ q: 'answer' });
  });

  it('ignores empty request ids and normalizes current index', () => {
    saveAskUserDraft('', {
      answers: {},
      currentIndex: 0,
      customInput: '',
      selectedLabels: [],
      showCustomInput: false,
    });
    saveAskUserDraft('req-1', {
      answers: {},
      currentIndex: 1.8,
      customInput: '',
      selectedLabels: [],
      showCustomInput: false,
    });

    expect(readAskUserDraft('')).toBeNull();
    expect(readAskUserDraft('req-1')?.currentIndex).toBe(1);
  });

  it('stores plan review drafts across remounts until the request resolves', () => {
    savePlanReviewDraft('plan-1', {
      feedback: '请补充风险控制',
      feedbackOpen: true,
      planText: '# Edited plan',
    });

    const draft = readPlanReviewDraft('plan-1');
    expect(draft).toEqual({
      feedback: '请补充风险控制',
      feedbackOpen: true,
      planText: '# Edited plan',
    });

    draft!.planText = '# Mutated';
    expect(readPlanReviewDraft('plan-1')?.planText).toBe('# Edited plan');

    clearPlanReviewDraft('plan-1');
    expect(readPlanReviewDraft('plan-1')).toBeNull();
  });

  // Changing an option's preview within the same requestId must invalidate stale drafts.
  it('changes askQuestionsIdentity when option preview changes', () => {
    const before = askQuestionsIdentity([{
      question: 'Send update?',
      options: [{ label: 'Send', preview: 'Draft v1' }, { label: 'Cancel' }],
    }]);
    const after = askQuestionsIdentity([{
      question: 'Send update?',
      options: [{ label: 'Send', preview: 'Draft v2' }, { label: 'Cancel' }],
    }]);
    expect(before).not.toBe(after);
    saveAskUserDraft('req-preview', {
      answers: { 'Send update?': 'Send' },
      currentIndex: 0,
      customInput: '',
      questionsIdentity: before,
      selectedLabels: ['Send'],
      showCustomInput: false,
    });
    expect(readAskUserDraftFor('req-preview', before)).not.toBeNull();
    expect(readAskUserDraftFor('req-preview', after)).toBeNull();
  });
});
