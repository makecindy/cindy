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

  it('limits ranges to the supplied message body', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<span>GPT label</span><div data-session-search-body>GPT body GPT</div>';
    const body = wrapper.querySelector('[data-session-search-body]');

    expect(body).not.toBeNull();
    expect(findSessionSearchRanges(body!, 'GPT').map((range) => range.toString())).toEqual([
      'GPT',
      'GPT',
    ]);
  });

  it('matches collapsed whitespace and maps the range back to rendered text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span>error</span>\n  <strong>timeout</strong>';

    const ranges = findSessionSearchRanges(root, 'error timeout');

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe('error\n  timeout');
  });

  it('skips interactive and aria-hidden text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>GPT</p><button>GPT</button><span aria-hidden="true">GPT</span>';

    expect(findSessionSearchRanges(root, 'GPT')).toHaveLength(1);
  });
});
