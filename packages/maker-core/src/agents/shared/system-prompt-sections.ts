/** One assembly path for fixed Host text and ordered, task-local contributions. */
export interface SystemPromptSection { name: string; order: number; text: string }
export function assembleSystemPromptSections(fixedPrefix: string, sections: readonly SystemPromptSection[]): string {
  if (!sections.length) return fixedPrefix;
  const suffix = [...sections].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(section => section.text.trim()).filter(Boolean).join('\n\n');
  return suffix ? fixedPrefix + (fixedPrefix ? '\n\n' : '') + suffix : fixedPrefix;
}
