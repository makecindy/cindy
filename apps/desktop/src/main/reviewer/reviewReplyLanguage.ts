/**
 * The language the user writes in, detected from their own task messages.
 *
 * Review prompts are fixed host text, and a model answering a fixed-language
 * prompt drifts toward that language. A Japanese task then receives a Chinese
 * review, and the source agent continues in Chinese after reading it. Naming the
 * user's language explicitly keeps both turns in it. Only scripts that identify
 * a language are named; Latin text stays "the user's language" because English,
 * French and others cannot be told apart this way.
 */
export type ReviewReplyLanguage = 'ja' | 'ko' | 'zh';

const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/gu;
const HANGUL = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/gu;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
const LATIN = /[A-Za-z\u00c0-\u024f]/gu;

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

export function detectReviewReplyLanguage(userTexts: readonly string[]): ReviewReplyLanguage | null {
  // Code, paths and identifiers are Latin regardless of the user's language.
  const prose = userTexts
    .join('\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s]*/g, ' ');
  const kana = count(prose, KANA);
  const hangul = count(prose, HANGUL);
  const han = count(prose, HAN);
  const latin = count(prose, LATIN);
  // Latin words count roughly five letters per word; scripts count per character.
  const latinWeight = latin / 5;
  if (hangul > 0 && hangul >= kana && hangul >= latinWeight) return 'ko';
  if (kana > 0 && kana + han >= latinWeight) return 'ja';
  if (han > 0 && han >= latinWeight) return 'zh';
  return null;
}

const NAMES: Record<ReviewReplyLanguage, { zh: string; en: string }> = {
  ja: { zh: '日语', en: 'Japanese' },
  ko: { zh: '韩语', en: 'Korean' },
  zh: { zh: '中文（与用户使用的简体或繁体一致）', en: "Chinese (matching the user's simplified or traditional script)" },
};

/** Reviewer instruction, in the language of the review prompt. */
export function reviewerReplyLanguageInstruction(language: ReviewReplyLanguage | null): string {
  return language
    ? `用户在本任务中使用${NAMES[language].zh}：全部结论必须用${NAMES[language].zh}书写（代码、路径、标识符保持原样），不要因为本提示是中文而改用中文。`
    : '使用用户在任务上下文中所用的语言作答（代码、路径、标识符保持原样），不要因为本提示是中文而改用中文。';
}

/** Source-agent instruction for the follow-up turn. */
export function followUpReplyLanguageInstruction(language: ReviewReplyLanguage | null): string {
  const target = language
    ? `${NAMES[language].en}, the language of the user's own messages in this task`
    : "the language the user has been using in this task (the language of the user's own messages)";
  return `Reply in ${target}. Do not switch to the language of this note or of the review text.`;
}
