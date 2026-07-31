// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { findSessionSearchRanges } from '../sessionSearchHighlight';

describe('findSessionSearchRanges', () => {
  it('finds every case-insensitive occurrence', () => {
    const root = document.createElement('div');
    root.textContent = 'GPT and gpt and GPT';

    const ranges = findSessionSearchRanges(root, 'gpt');

    expect(ranges.map((range) => range.toString())).toEqual(['GPT', 'gpt', 'GPT']);
  });

  it('creates a range across markdown text nodes', () => {
    const root = document.createElement('div');
    root.innerHTML = '<strong>GP</strong><span>T-5.6</span>';

    const ranges = findSessionSearchRanges(root, 'GPT');

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe('GPT');
  });

  it('skips interactive and aria-hidden text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>GPT</p><button>GPT</button><span aria-hidden="true">GPT</span>';

    expect(findSessionSearchRanges(root, 'GPT')).toHaveLength(1);
  });
});
