import { record } from './models.js';

/** Cindy desktop/mobile serialize multiple selected labels as a JSON string[]. */
export function cursorAnswers(questions: unknown[], answers: Record<string, string>): unknown {
  const parsed = questions.map(record);
  if (new Set(parsed.map(item => item.prompt)).size !== parsed.length) {
    return { outcome: { outcome: 'skipped', reason: 'Duplicate question prompts cannot be represented by this client' } };
  }
  const results: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
  for (const question of parsed) {
    const answer = answers[String(question.id)] ?? answers[String(question.prompt)];
    let labels: string[] = typeof answer === 'string' && answer ? [answer] : [];
    if (question.allowMultiple === true && answer) {
      try {
        const decoded: unknown = JSON.parse(answer);
        if (Array.isArray(decoded) && decoded.every(value => typeof value === 'string')) labels = decoded;
      } catch { /* a single selected label remains a valid answer */ }
    }
    const options = (Array.isArray(question.options) ? question.options : []).map(record);
    const selected: string[] = [];
    for (const label of labels) {
      const matches = options.filter(option => option.label === label && typeof option.id === 'string');
      if (matches.length !== 1) return { outcome: { outcome: 'skipped', reason: 'Free-text or ambiguous answers are not supported by Cursor ACP' } };
      selected.push(matches[0].id as string);
    }
    if (!selected.length || (question.allowMultiple !== true && selected.length !== 1)) {
      return { outcome: { outcome: 'skipped', reason: 'No unambiguous option selected' } };
    }
    results.push({ questionId: String(question.id), selectedOptionIds: [...new Set(selected)] });
  }
  return { outcome: { outcome: 'answered', answers: results } };
}
