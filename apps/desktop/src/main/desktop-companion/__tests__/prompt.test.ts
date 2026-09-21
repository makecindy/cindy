import { describe, expect, it } from 'vitest';

import { buildDesktopCompanionPrompt, buildDesktopCompanionVideoPrompt } from '../prompt.js';

describe('desktop companion prompt', () => {
  it('keeps Cindy in the corner and does not embed raw chat', () => {
    const { prompt, topic } = buildDesktopCompanionPrompt({
      timeSlot: 'night',
      city: '杭州',
      taskTitle: '桌面互动',
      memoryTopics: ['夜墨主题'],
      mode: 'together',
    });
    expect(prompt).toContain('bottom-right');
    expect(prompt).toContain('85%');
    expect(prompt).toContain('杭州');
    expect(prompt).not.toContain('SELECT ');
    expect(topic).toContain('桌面互动');
  });

  it('builds a looping video prompt from the still topic', () => {
    const prompt = buildDesktopCompanionVideoPrompt('杭州 · night');
    expect(prompt).toContain('looping');
    expect(prompt).toContain('杭州');
  });
});
