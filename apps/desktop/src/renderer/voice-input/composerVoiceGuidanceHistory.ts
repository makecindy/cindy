/** Local teaching history shared by all task composers, never task content. */
const KEY = 'cindy.composer-voice-guidance.v1';
export const COMPOSER_VOICE_GUIDANCE_CHANGED = 'cindy:composer-voice-guidance-changed';
type History = { count: number; lastDay: string; learned: boolean };
let memoryOnly = false;
let fallback: History = { count: 0, lastDay: '', learned: false };

function read(): History {
  if (memoryOnly) return fallback;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    fallback = {
      count: Number.isInteger(value?.count) && value.count >= 0 ? value.count : 0,
      lastDay: typeof value?.lastDay === 'string' ? value.lastDay : '',
      learned: value?.learned === true,
    };
  } catch {
    memoryOnly = true; // Keep the limit for this run when storage is unavailable.
  }
  return fallback;
}
function write(value: History): void {
  fallback = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    memoryOnly = true; // A readable but unwritable store must not reset the limit.
  }
}
function localDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}
export function claimComposerVoiceGuidance(): boolean {
  const history = read();
  const day = localDay();
  if (history.learned || history.count >= 3 || history.lastDay === day) return false;
  write({ ...history, count: history.count + 1, lastDay: day });
  return true;
}
export function markComposerVoiceGuidanceLearned(): void {
  write({ ...read(), learned: true });
  window.dispatchEvent(new Event(COMPOSER_VOICE_GUIDANCE_CHANGED));
}
