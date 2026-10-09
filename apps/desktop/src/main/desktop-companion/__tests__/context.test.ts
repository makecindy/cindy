import { describe, expect, it } from 'vitest';

import {
  buildFingerprint,
  characterModeFor,
  memoryKeyFromTopics,
  sanitizeSceneText,
  timeSlotAt,
} from '../context.js';

describe('desktop companion context', () => {
  it('maps hours to time slots', () => {
    expect(timeSlotAt(new Date('2026-09-18T07:00:00')).toString()).toBe(timeSlotAt(new Date(2026, 8, 18, 7)).toString());
    expect(timeSlotAt(new Date(2026, 8, 18, 7))).toBe('morning');
    expect(timeSlotAt(new Date(2026, 8, 18, 12))).toBe('noon');
    expect(timeSlotAt(new Date(2026, 8, 18, 17))).toBe('dusk');
    expect(timeSlotAt(new Date(2026, 8, 18, 23))).toBe('night');
  });

  it('uses together mode only when a recent task exists', () => {
    expect(characterModeFor(true)).toBe('together');
    expect(characterModeFor(false)).toBe('companion');
  });

  it('strips urls, emails and paths from scene text', () => {
    const raw = 'see https://secret.example/x and /Users/leng/secret.ts mail a@b.com 优惠券';
    const cleaned = sanitizeSceneText(raw, 80);
    expect(cleaned).not.toContain('https://');
    expect(cleaned).not.toContain('/Users/');
    expect(cleaned).not.toContain('@');
    expect(cleaned).toContain('优惠券');
  });

  it('builds a stable fingerprint from scene parts', () => {
    const fingerprint = buildFingerprint({
      timeSlot: 'night',
      city: '杭州',
      taskTitle: 'desktop companion',
      mode: 'together',
      memoryKey: memoryKeyFromTopics(['Cindy 夜墨', 'https://leak.example']),
    });
    expect(fingerprint).toContain('night');
    expect(fingerprint).toContain('杭州');
    expect(fingerprint).not.toContain('https://');
  });
});
