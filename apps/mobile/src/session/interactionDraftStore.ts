import type { AskQuestion } from '@cindy/maker-shared/interaction';

export interface AskUserDraft {
  answers: Record<string, string>;
  currentIndex: number;
  customInput: string;
  /** 保存草稿时的问题内容;同一 requestId 的问题变了,旧草稿不再恢复。 */
  questionsIdentity?: string;
  selectedLabels: string[];
  showCustomInput: boolean;
}

export interface PlanReviewDraft {
  feedback: string;
  feedbackOpen: boolean;
  planText: string;
}

const askUserDrafts = new Map<string, AskUserDraft>();
const planReviewDrafts = new Map<string, PlanReviewDraft>();

export function readAskUserDraft(requestId: string): AskUserDraft | null {
  const draft = askUserDrafts.get(requestId);
  return draft ? cloneDraft(draft) : null;
}

/** 与桌面 AskUserQuestionPrompt 同口径的问题内容标识(字段顺序固定,缺省 options 等同空)。 */
export function askQuestionsIdentity(questions: AskQuestion[]): string {
  return JSON.stringify(questions.map((question) => [
    question.question,
    question.header,
    question.multiSelect,
    (question.options ?? []).map((option) => [option.label, option.description]),
  ]));
}

/** 只返回与当前问题内容一致的草稿:同一 requestId 的问题变了,旧草稿视为不存在。 */
export function readAskUserDraftFor(requestId: string, questionsIdentity: string): AskUserDraft | null {
  const draft = readAskUserDraft(requestId);
  return draft?.questionsIdentity === questionsIdentity ? draft : null;
}

export function saveAskUserDraft(requestId: string, draft: AskUserDraft): void {
  if (!requestId) return;
  askUserDrafts.set(requestId, cloneDraft(draft));
}

export function clearAskUserDraft(requestId: string): void {
  askUserDrafts.delete(requestId);
}

export function readPlanReviewDraft(requestId: string): PlanReviewDraft | null {
  const draft = planReviewDrafts.get(requestId);
  return draft ? clonePlanReviewDraft(draft) : null;
}

export function savePlanReviewDraft(requestId: string, draft: PlanReviewDraft): void {
  if (!requestId) return;
  planReviewDrafts.set(requestId, clonePlanReviewDraft(draft));
}

export function clearPlanReviewDraft(requestId: string): void {
  planReviewDrafts.delete(requestId);
}

export function clearAllInteractionDrafts(): void {
  askUserDrafts.clear();
  planReviewDrafts.clear();
}

function cloneDraft(draft: AskUserDraft): AskUserDraft {
  return {
    answers: { ...draft.answers },
    currentIndex: Math.max(0, Math.floor(draft.currentIndex)),
    customInput: draft.customInput,
    ...(draft.questionsIdentity !== undefined ? { questionsIdentity: draft.questionsIdentity } : {}),
    selectedLabels: [...draft.selectedLabels],
    showCustomInput: draft.showCustomInput,
  };
}

function clonePlanReviewDraft(draft: PlanReviewDraft): PlanReviewDraft {
  return {
    feedback: draft.feedback,
    feedbackOpen: draft.feedbackOpen,
    planText: draft.planText,
  };
}
