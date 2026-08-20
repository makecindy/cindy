import { describe, expect, it } from 'vitest';

import {
  isSearchLookupTool,
  isSearchRitualTool,
  SEARCH_MODE_PROMPT,
} from '../searchMode';

describe('searchMode', () => {
  it('blocks helpers and plugins, keeps web search', () => {
    expect(isSearchRitualTool('Task')).toBe(true);
    expect(isSearchRitualTool('Agent')).toBe(true);
    expect(isSearchRitualTool('Skill')).toBe(true);
    expect(isSearchRitualTool('collab:spawn')).toBe(true);
    expect(isSearchRitualTool('mcp__cindy__ghost_call')).toBe(true);
    expect(isSearchRitualTool('mcp__cindy_browser__call_tool')).toBe(true);
    expect(isSearchRitualTool('mcp__example__web_search')).toBe(true);
    expect(isSearchRitualTool('mcp__example__webfetch_file')).toBe(true);
    expect(isSearchLookupTool('WebSearch')).toBe(true);
    expect(isSearchLookupTool('web_search')).toBe(true);
    expect(isSearchRitualTool('WebSearch')).toBe(false);
    expect(isSearchRitualTool('WebFetch')).toBe(false);
    expect(isSearchRitualTool('web_search')).toBe(false);
  });

  it('keeps the wire note short and generic', () => {
    expect(SEARCH_MODE_PROMPT).toContain('search mode');
    expect(SEARCH_MODE_PROMPT).not.toContain('pi 是什么');
    expect(SEARCH_MODE_PROMPT).not.toContain('Steam');
  });
});
