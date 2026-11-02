import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadExperts } from '../expert-loader.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../docs/experts-examples');

describe('docs/experts-examples', () => {
  it('ships the starter experts and every one loads cleanly', () => {
    const entries = loadExperts(EXAMPLES);
    expect(entries.map((e) => e.slug)).toEqual(['code-reviewer', 'expert-creator', 'prompt-engineer', 'repo-explainer', 'research-analyst']);
    for (const entry of entries) {
      expect(entry.error, entry.slug).toBeUndefined();
      expect(entry.expert!.agent).toBe('hermes');
      expect(entry.expert!.description.length, entry.slug).toBeGreaterThan(10);
      expect(entry.expert!.prompt.length, entry.slug).toBeGreaterThan(200);
    }
  });

  it('only the expert creator lists a tool, and it is draft_expert (ROADMAP 3.8)', () => {
    const withTools = loadExperts(EXAMPLES).filter((e) => (e.expert?.tools.length ?? 0) > 0);
    expect(withTools.map((e) => [e.slug, e.expert!.tools])).toEqual([['expert-creator', ['draft_expert']]]);
  });

  it('only the research analyst keeps memory notes', () => {
    const memory = loadExperts(EXAMPLES).filter((e) => e.expert?.memory).map((e) => e.slug);
    expect(memory).toEqual(['research-analyst']);
  });
});
