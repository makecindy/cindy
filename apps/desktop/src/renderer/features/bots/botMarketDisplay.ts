import { cronToConfig } from '@/features/scheduler/lib/cronCodexPreset';
import { cronToHuman } from '@/features/scheduler/lib/cronToHuman';

type Translate = (key: string, options?: Record<string, unknown>) => string;
// cronToHuman localizes only these shapes; for any other it falls back to an English sentence.
const LOCALIZED_SHAPES = new Set(['daily', 'weekdays', 'weekly', 'monthly']);

/**
 * Human-readable rhythm of a package routine in the current language, or undefined when it cannot be said
 * in that language (the row is then hidden rather than showing a cron string or an English sentence).
 */
export function botRoutineRhythm(cron: string, t: Translate, language: string): string | undefined {
  const expression = cron.trim();
  const [minute, ...rest] = expression.split(/\s+/);
  if (rest.length === 4 && rest.every(field => field === '*')) {
    if (minute === '0') return t('routines.hourly');
    const step = /^\*\/(\d+)$/.exec(minute!)?.[1];
    if (step && 60 % Number(step) === 0) return t('routines.everyMinutes', { count: Number(step) });
    // An even list that starts at :00, such as `0,30`, is the same as `*/30`.
    const list = /^\d+(?:,\d+)+$/.test(minute!) ? minute!.split(',').map(Number) : [];
    const gap = (list[1] ?? 0) - (list[0] ?? 0);
    if (list[0] === 0 && gap > 0 && 60 % gap === 0 && list.length === 60 / gap && list.every((value, index) => value === index * gap)) {
      return t('routines.everyMinutes', { count: gap });
    }
    return undefined;
  }
  return LOCALIZED_SHAPES.has(cronToConfig(expression).mode) ? cronToHuman(expression, t, language) : undefined;
}

// Bundled dependencies' published names; installed/catalog metadata takes priority.
export const bundledPluginNames: Record<string, string> = {
  'cindy-github': 'GitHub',
  'cindy-gitlab': 'GitLab',
  'cindy-notion': 'Notion',
  'google-sheets': 'Google Sheets',
  'google-gmail': 'Gmail',
  'outlook-mail': 'Outlook',
  'google-drive': 'Google Drive',
  'cindy-web-search': 'Web Search',
  'x-manager': 'X Manager',
  'cindy-art': 'Art',
  'opendesign-trial': 'OpenDesign',
  'cindy-simulator': 'Device Simulator',
  'baguette-simulator': 'Device Simulator',
};
