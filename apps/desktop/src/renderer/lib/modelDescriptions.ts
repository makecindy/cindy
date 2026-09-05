import { classifyModel } from '@cindy/model-providers';
import type { TFunction } from 'i18next';

/** Editorial display copy only: never use a description to infer routing or capabilities.
 * Families intentionally accept future versions; new families remain visible without a blurb.
 * Raw catalog descriptions are retained in the catalog, but never used as UI fallback.
 */
const families: ReadonlyArray<readonly [RegExp, string]> = [
  [/^gpt-.*\[1m\]$/, 'longContext'],
  [/^gpt-.*-cyber(?:-|$)/, 'security'],
  [/^gpt-.*-astra(?:-|$)/, 'research'],
  [/^gpt-.*(?:-luna|-mini|-nano|-spark)(?:-|$)/, 'quickCoding'],
  [/^(?:gpt-.*-pro(?:-|$)|o[134](?:-|$))/, 'reasoning'],
  [/^gpt-/, 'coding'],
  [/^claude-fable-/, 'sustainedWork'],
  [/^claude-opus-/, 'complexWork'],
  [/^claude-sonnet-/, 'everydayWork'],
  [/^claude-haiku-/, 'quickAnswers'],
  [/^claude-/, 'everydayWork'],
  [/^gemini-.*flash-lite/, 'shortTasks'],
  [/^gemini-.*flash/, 'everydayWork'],
  [/^gemini-/, 'research'],
  [/^deepseek-.*(?:-vision|-vl)/, 'everydayWork'],
  [/^deepseek-.*-flash(?:-|$)/, 'everydayWork'],
  [/^deepseek-/, 'reasoning'],
  [/^qwen(?:\d|[-/])/, 'writingAndCoding'],
  [/^kimi-.*-code(?:-|$)/, 'coding'],
  [/^kimi-/, 'readingAndWriting'],
  [/^glm-/, 'writingAndCoding'],
  [/^(?:doubao-)?seed-\d/, 'everydayWork'],
  [/^(?:hy\d|hunyuan(?:-|\d))/, 'readingAndWriting'],
  [/^minimax-/, 'coding'],
  [/^muse-spark-/, 'everydayWork'],
  [/^grok-(?:build|code)-/, 'coding'],
  [/^grok-/, 'reasoning'],
];

const categoryKeys: Readonly<Record<string, string>> = {
  image: 'image', video: 'video', tts: 'speech', stt: 'transcription',
  realtime: 'realtime', embedding: 'embedding', compression: 'compression',
};

export function modelDescriptionKey(model: { id: string; group?: string; mode?: string }): string | undefined {
  // A vendor grouping like "gpt" must not turn GPT Image into a coding model.
  const inferredCategory = classifyModel({ id: model.id, mode: model.mode });
  const category = model.mode !== undefined || Object.hasOwn(categoryKeys, inferredCategory)
    ? inferredCategory : classifyModel(model);
  if (Object.hasOwn(categoryKeys, category)) return categoryKeys[category];
  // An explicitly non-chat/unknown mode must not inherit a chat-family blurb.
  if (category === 'other') return undefined;
  let id = model.id.toLowerCase().split('/').at(-1) ?? '';
  // Registry internal XD IDs have flattened route prefixes. Wire IDs usually don't.
  if (model.id.startsWith('xd/')) {
    id = id.replace(/^(?:codex|z-ai|moonshotai|deepseek|tencent)-(?=gpt-|glm-|kimi-|deepseek-|hy\d)/, '');
  }
  return families.find(([pattern]) => pattern.test(id))?.[1];
}

export function localizedModelDescription(
  model: { id: string; group?: string; mode?: string },
  t: TFunction,
): string | undefined {
  const key = modelDescriptionKey(model);
  if (!key) return undefined;
  return t(`modelDescriptions.${key}`, { defaultValue: '' }) || undefined;
}
