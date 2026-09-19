import type {
  DesktopCompanionCharacterMode,
  DesktopCompanionTimeSlot,
} from '../../shared/desktopCompanion.js';

const TIME_SCENERY: Record<DesktopCompanionTimeSlot, string> = {
  morning: 'cool morning light, pale sky, quiet air',
  noon: 'clear daylight, soft high sun, calm interior shade',
  dusk: 'warm dusk light, long shadows, amber window glow',
  night: 'deep night, city lights or moonlight, quiet indoor lamps',
};

const MODE_BEAT: Record<DesktopCompanionCharacterMode, string> = {
  together: 'She sits with the viewer, looking at the same work, present in the room.',
  companion: 'She turns slightly toward the viewer with a small caring pause, a mug or folded hands.',
};

export interface DesktopCompanionPromptInput {
  timeSlot: DesktopCompanionTimeSlot;
  city: string | null;
  taskTitle: string | null;
  memoryTopics: string[];
  mode: DesktopCompanionCharacterMode;
}

export function buildDesktopCompanionPrompt(input: DesktopCompanionPromptInput): { prompt: string; topic: string } {
  const scenery = TIME_SCENERY[input.timeSlot];
  const cityLine = input.city
    ? 'A window hint of ' + input.city + ' in the distance, no readable street signs.'
    : 'A window of atmosphere only, no named city.';
  const taskLine = input.taskTitle
    ? 'Tiny unreadable desk clues about: ' + input.taskTitle + '.'
    : 'An idle desk, nothing urgent.';
  const eggs = input.memoryTopics
    .slice(0, 3)
    .map((topic) => topic.trim())
    .filter(Boolean)
    .map((topic) => 'a tiny unreadable object hinting at "' + topic + '"')
    .join(', ');
  const eggLine = eggs ? 'Easter eggs, thumbnail-sized, no letters: ' + eggs + '.' : 'No extra props.';

  const prompt = [
    'Official Cindy character. Match the attached product portrait exactly: same face, hair, skin, eyes, and outfit.',
    '3:2 desktop wallpaper. Cindy occupies only the bottom-right ~15%. Keep ~85% empty, quiet, and uncluttered so desktop icons stay readable.',
    'No text, logos, watermarks, UI chrome, or readable writing anywhere.',
    MODE_BEAT[input.mode],
    'Lighting and window: ' + scenery + '. ' + cityLine,
    taskLine,
    eggLine,
    'Still, cinematic, photographic, shallow depth, generous negative space on the left and top.',
  ].join(' ');

  const topic = [input.taskTitle, input.city, input.timeSlot, input.mode].filter(Boolean).join(' · ');
  return { prompt, topic: topic || input.timeSlot };
}

export function buildDesktopCompanionVideoPrompt(topic: string): string {
  return [
    'Gentle looping motion of the same scene.',
    'Cindy breathes and the window light shifts slightly.',
    'No new objects, no camera cut, no text.',
    topic ? 'Keep the mood of: ' + topic + '.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
