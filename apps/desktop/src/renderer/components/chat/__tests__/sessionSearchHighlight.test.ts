// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { findSessionSearchRanges } from '../sessionSearchHighlight';

describe('findSessionSearchRanges', () => {
  it('finds every case-insensitive occurrence', () => {
    const root = document.createElement('div'); root.textContent = 'GPT and gpt and GPT';
    expect(findSessionSearchRanges(root, 'gpt').map((r) => r.toString())).toEqual(['GPT', 'gpt', 'GPT']);
  });
  it('creates a range across markdown text nodes', () => {
    const root = document.createElement('div'); root.innerHTML = '<strong>GP</strong><span>T-5.6</span>';
    expect(findSessionSearchRanges(root, 'GPT')[0].toString()).toBe('GPT');
  });
  it('limits ranges to the supplied message body', () => {
    const root = document.createElement('div'); root.innerHTML = '<span>GPT label</span><div data-session-search-body>GPT body GPT</div>';
    const body = root.querySelector('[data-session-search-body]')!;
    expect(findSessionSearchRanges(body, 'GPT').map((r) => r.toString())).toEqual(['GPT', 'GPT']);
  });
  it('matches across block boundaries while preserving inline splits', () => {
    const root = document.createElement('div'); root.innerHTML = '<p>error</p><p>timeout</p>';
    expect(findSessionSearchRanges(root, 'error timeout')).toHaveLength(1);
    const inline = document.createElement('div'); inline.innerHTML = '<strong>GP</strong><span>T</span>';
    expect(findSessionSearchRanges(inline, 'GPT')).toHaveLength(1);
  });
  it('skips interactive and aria-hidden text', () => {
    const root = document.createElement('div'); root.innerHTML = '<p>GPT</p><button>GPT</button><span aria-hidden="true">GPT</span>';
    expect(findSessionSearchRanges(root, 'GPT')).toHaveLength(1);
  });
});
