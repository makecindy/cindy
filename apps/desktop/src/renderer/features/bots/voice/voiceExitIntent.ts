/** Only finalized, whole utterances are controls. Keep quotes, questions,
 * negation and extra clauses intact so discussing a farewell never hangs up.
 * These are voice-local controls, not prompts or commands sent to the task.
 */
export function voiceExitIntent(text: string): 'command' | 'farewell' | null {
  const phrase = text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[。.!！]+$/u, '')
    .trim()
    .replace(/\s+/gu, ' ');
  if (
    /^(?:请|請)?(?:结束|結束|退出|关闭|關閉)语音(?:模式|对话)?$/u.test(phrase) ||
    /^(?:請)?(?:結束|退出|關閉)語音(?:模式|對話)?$/u.test(phrase) ||
    /^(?:end|exit|close) (?:voice mode|voice chat)$/u.test(phrase)
  )
    return 'command';
  if (['再见', '再見', '拜拜', 'bye', 'bye bye', 'goodbye'].includes(phrase)) return 'farewell';
  return null;
}
