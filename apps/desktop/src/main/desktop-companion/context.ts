import type {
  DesktopCompanionCharacterMode,
  DesktopCompanionTimeSlot,
} from '../../shared/desktopCompanion.js';

const PATH_RE = /(?:\/Users|\/home|\/var|\/tmp|\/private|[A-Za-z]:\\)\S+/g;
const URL_RE = /https?:\/\/\S+/gi;
const EMAIL_RE = /\S+@\S+/g;

export function timeSlotAt(date: Date): DesktopCompanionTimeSlot {
  const hour = date.getHours();
  if (hour >= 6 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 16) return 'noon';
  if (hour >= 16 && hour < 19) return 'dusk';
  return 'night';
}

export function characterModeFor(hasRecentTask: boolean): DesktopCompanionCharacterMode {
  return hasRecentTask ? 'together' : 'companion';
}

export function sanitizeSceneText(raw: string, maxChars = 40): string {
  const cleaned = raw
    .replace(URL_RE, ' ')
    .replace(EMAIL_RE, ' ')
    .replace(PATH_RE, ' ')
    .replace(/[\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trim();
}

export function buildFingerprint(parts: {
  timeSlot: DesktopCompanionTimeSlot;
  city: string | null;
  taskTitle: string | null;
  mode: DesktopCompanionCharacterMode;
  memoryKey: string;
}): string {
  return [
    parts.timeSlot,
    parts.city ?? '',
    parts.taskTitle ?? '',
    parts.mode,
    parts.memoryKey,
  ].join('|');
}

export function memoryKeyFromTopics(topics: readonly string[]): string {
  return topics
    .slice(0, 3)
    .map((topic) => sanitizeSceneText(topic, 24))
    .filter(Boolean)
    .join(',');
}
