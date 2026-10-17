import { describe, expect, it } from 'vitest';

import {
  botSessionInputBlockReason,
  isShadowedCompanionCanonical,
} from '../botSessionInputGuard.js';

describe('Bot task input guard', () => {
  it('does not affect ordinary Cindy tasks', () => {
    expect(
      botSessionInputBlockReason({ source: 'desktop', role: null, profileStatus: null }),
    ).toBeNull();
  });

  it('blocks a canonical task while its Bot is paused', () => {
    expect(
      botSessionInputBlockReason({ source: 'bot', role: 'canonical', profileStatus: 'paused' }),
    ).toContain('未启用');
  });

  it('keeps archived history read-only even after the Bot resumes', () => {
    expect(
      botSessionInputBlockReason({ source: 'bot', role: 'history', profileStatus: 'active' }),
    ).toContain('只读');
  });

  it('fails closed when a Bot task loses its ownership link', () => {
    expect(
      botSessionInputBlockReason({ source: 'bot', role: null, profileStatus: null }),
    ).toContain('归属信息不完整');
  });
});

describe('shadowed companion guard', () => {
  const shadowed = (botId: string) => botId === 'bot_mia';
  it('blocks only the main task of a demoted copy', () => {
    expect(isShadowedCompanionCanonical({ role: 'canonical', botId: 'bot_mia' }, shadowed)).toBe(
      true,
    );
    expect(isShadowedCompanionCanonical({ role: 'delegation', botId: 'bot_mia' }, shadowed)).toBe(
      false,
    );
    expect(isShadowedCompanionCanonical({ role: 'canonical', botId: 'bot_other' }, shadowed)).toBe(
      false,
    );
    expect(isShadowedCompanionCanonical(null, shadowed)).toBe(false);
  });
});
