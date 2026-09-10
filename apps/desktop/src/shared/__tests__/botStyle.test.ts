import { describe, expect, it } from 'vitest';

import {
  BOT_STYLE_LIMITS,
  buildBotStyleGuidance,
  botStyleEqual,
  normalizeBotStyle,
  reconcileBotStyle,
} from '../botStyle';

describe('normalizeBotStyle', () => {
  it('returns undefined for empty or dirty values', () => {
    expect(normalizeBotStyle(undefined)).toBeUndefined();
    expect(normalizeBotStyle(null)).toBeUndefined();
    expect(normalizeBotStyle('warm')).toBeUndefined();
    expect(normalizeBotStyle({ tone: 'mysterious', customTone: '   ' })).toBeUndefined();
  });

  it('keeps known enums and trims text', () => {
    expect(
      normalizeBotStyle({
        tone: 'warm',
        customTone: '  像老朋友  ',
        addressUserAs: ' Chris ',
        selfName: '小柴',
        replyLength: 'short',
        emojiDensity: 'none',
        bannedPhrases: '  亲爱的  ',
        languageHabits: '先结论后解释',
      }),
    ).toEqual({
      tone: 'warm',
      customTone: '像老朋友',
      addressUserAs: 'Chris',
      selfName: '小柴',
      replyLength: 'short',
      emojiDensity: 'none',
      bannedPhrases: '亲爱的',
      languageHabits: '先结论后解释',
    });
  });

  it('clips oversized free text instead of rejecting the whole object', () => {
    const next = normalizeBotStyle({
      languageHabits: '啊'.repeat(BOT_STYLE_LIMITS.languageHabits + 8),
    });
    expect(next?.languageHabits).toHaveLength(BOT_STYLE_LIMITS.languageHabits);
  });

  it('keeps the first 40 banned phrases for persistence and prompt rendering', () => {
    const items = Array.from({ length: BOT_STYLE_LIMITS.bannedPhraseItems + 1 }, (_, i) => `禁${i + 1}`);
    const next = normalizeBotStyle({ bannedPhrases: items.join('\n') });
    const saved = next?.bannedPhrases?.split('\n') ?? [];
    expect(saved).toHaveLength(BOT_STYLE_LIMITS.bannedPhraseItems);
    expect(saved).toEqual(items.slice(0, BOT_STYLE_LIMITS.bannedPhraseItems));
    const guidance = buildBotStyleGuidance(next);
    expect(guidance).toContain('「禁1」');
    expect(guidance).toContain(`「禁${BOT_STYLE_LIMITS.bannedPhraseItems}」`);
    expect(guidance).not.toContain(`「禁${BOT_STYLE_LIMITS.bannedPhraseItems + 1}」`);
  });
});

describe('botStyleEqual', () => {
  it('treats empty objects and missing style as the same unset value', () => {
    expect(botStyleEqual(undefined, {})).toBe(true);
    expect(botStyleEqual(undefined, null)).toBe(true);
    expect(botStyleEqual({ tone: 'warm' }, { tone: 'warm', customTone: '  ' })).toBe(true);
    expect(botStyleEqual({ tone: 'warm' }, { tone: 'concise' })).toBe(false);
  });
});

describe('reconcileBotStyle', () => {
  it('keeps a concurrent tone when this window only edits addressUserAs', () => {
    expect(
      reconcileBotStyle(
        { tone: 'warm', addressUserAs: 'Chris' },
        { tone: 'warm', addressUserAs: 'Pat' },
        { tone: 'concise', addressUserAs: 'Chris' },
      ),
    ).toEqual({ tone: 'concise', addressUserAs: 'Pat' });
  });

  it('clears only the field this window emptied', () => {
    expect(
      reconcileBotStyle(
        { tone: 'warm', selfName: '小满' },
        { tone: 'warm' },
        { tone: 'warm', selfName: '小满', addressUserAs: 'Chris' },
      ),
    ).toEqual({ tone: 'warm', addressUserAs: 'Chris' });
  });

  it('returns undefined when this window cleared every baseline field and remote added none', () => {
    expect(reconcileBotStyle({ tone: 'warm' }, null, { tone: 'warm' })).toBeUndefined();
  });
});

describe('buildBotStyleGuidance', () => {
  it('returns empty when there is nothing concrete to say', () => {
    expect(buildBotStyleGuidance(undefined)).toBe('');
    expect(buildBotStyleGuidance({ tone: 'custom' })).toBe('');
    expect(buildBotStyleGuidance({ tone: undefined, replyLength: undefined, emojiDensity: undefined })).toBe('');
  });

  it('does not override SOUL and tells the bot not to rewrite style', () => {
    const guidance = buildBotStyleGuidance({
      tone: 'professional',
      addressUserAs: 'Chris',
      selfName: '小满',
      replyLength: 'medium',
      emojiDensity: 'sparse',
      bannedPhrases: '亲爱的\n老板',
      languageHabits: '先给结论',
    });
    expect(guidance).toContain('## 说话习惯');
    expect(guidance).toContain('不覆盖上面的身份(SOUL)');
    expect(guidance).toContain('不要自行改写这段风格');
    expect(guidance).toContain('称呼用户为「Chris」');
    expect(guidance).toContain('自称「小满」');
    expect(guidance).toContain('「亲爱的」');
    expect(guidance).toContain('「老板」');
    expect(guidance).toContain('先给结论');
    expect(guidance).toContain('专业、克制');
  });

  it('uses custom tone text only when tone is custom', () => {
    const custom = buildBotStyleGuidance({
      tone: 'custom',
      customTone: '像编辑部同事,短句,不卖萌',
    });
    expect(custom).toContain('像编辑部同事,短句,不卖萌');
    const warm = buildBotStyleGuidance({
      tone: 'warm',
      customTone: '这段不该盖过预设',
    });
    expect(warm).toContain('温暖、亲近');
    expect(warm).not.toContain('这段不该盖过预设');
  });
});
