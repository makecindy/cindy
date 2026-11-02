import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderExpertMarkdown, validateExpertDraft, writeExpertDraft, type ExpertDraft } from '../expert-draft';
import { loadExperts } from '../expert-loader';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-draft-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: 'uk-cold-email',
  name: 'UK Cold Email Writer',
  description: 'Writes short B2B cold emails for UK buyers.',
  tags: ['sales', 'email'],
  prompt: 'You write cold emails.\n\nRules:\n- Under 120 words.\n- One ask.',
  ...over,
});

const valid = (over: Record<string, unknown> = {}): ExpertDraft => {
  const check = validateExpertDraft(input(over));
  if (!check.ok) throw new Error(check.errors.join('; '));
  return check.draft;
};

describe('validateExpertDraft', () => {
  it('accepts a complete draft and normalises it', () => {
    const check = validateExpertDraft(input({ name: '  UK Cold Email Writer ', tags: ['sales', 'sales', 'email'] }));
    expect(check).toEqual({
      ok: true,
      draft: {
        slug: 'uk-cold-email',
        name: 'UK Cold Email Writer',
        description: 'Writes short B2B cold emails for UK buyers.',
        tags: ['sales', 'email'],
        memory: false,
        prompt: 'You write cold emails.\n\nRules:\n- Under 120 words.\n- One ask.',
      },
    });
  });

  it.each([
    ['bad slug', { slug: '../etc' }, '"slug"'],
    ['upper-case slug', { slug: 'Cold-Email' }, '"slug"'],
    ['dot slug', { slug: '.hidden' }, '"slug"'],
    ['missing name', { name: '' }, '"name"'],
    ['multi-line name', { name: 'a\nb' }, '"name"'],
    ['missing description', { description: undefined }, '"description"'],
    ['missing prompt', { prompt: '   ' }, '"prompt"'],
    ['oversized prompt', { prompt: 'x'.repeat(20_001) }, '"prompt"'],
    ['tools', { tools: ['draft_expert'] }, '"tools"'],
    ['other agent', { agent: 'codex' }, '"agent"'],
    ['bad memory', { memory: 'yes' }, '"memory"'],
    ['bad tags', { tags: 'sales' }, '"tags"'],
  ])('rejects %s', (_label, over, needle) => {
    const check = validateExpertDraft(input(over));
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.errors.join(' ')).toContain(needle);
  });

  it('never throws on junk', () => {
    expect(validateExpertDraft(null).ok).toBe(false);
    expect(validateExpertDraft('x').ok).toBe(false);
  });
});

describe('renderExpertMarkdown', () => {
  it('writes frontmatter the loader reads back, with no tools line', () => {
    const md = renderExpertMarkdown(valid({ model: 'strong', memory: true, description: 'Says "hi": always' }));
    expect(md).not.toMatch(/^tools:/m);
    expect(md).toMatch(/^agent: hermes$/m);
    // One line per field, even for a long description (hand-editable, no folded block).
    const long = renderExpertMarkdown(valid({ description: 'Writes short UK B2B cold emails for facility managers, under 120 words with one clear ask.' }));
    expect(long).toMatch(/^description: .*one clear ask\.'?$/m);
    expect(long).not.toContain('>-');
    const dir = path.join(root, 'x');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'expert.md'), md);
    const [entry] = loadExperts(root);
    expect(entry.error).toBeUndefined();
    expect(entry.expert).toMatchObject({ name: 'UK Cold Email Writer', description: 'Says "hi": always', model: 'strong', memory: true, tools: [], tags: ['sales', 'email'] });
    expect(entry.expert!.prompt).toBe('You write cold emails.\n\nRules:\n- Under 120 words.\n- One ask.');
  });
});

describe('writeExpertDraft', () => {
  it('writes a loadable expert and leaves no temp folder', () => {
    const res = writeExpertDraft(path.join(root, 'experts'), valid());
    expect(res).toEqual({ ok: true, dir: path.join(root, 'experts', 'uk-cold-email'), file: path.join(root, 'experts', 'uk-cold-email', 'expert.md') });
    expect(fs.readdirSync(path.join(root, 'experts'))).toEqual(['uk-cold-email']);
    const [entry] = loadExperts(path.join(root, 'experts'));
    expect(entry.slug).toBe('uk-cold-email');
    expect(entry.expert?.name).toBe('UK Cold Email Writer');
  });

  it('never overwrites an existing expert folder', () => {
    const existing = path.join(root, 'uk-cold-email');
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, 'expert.md'), 'hand written');
    const res = writeExpertDraft(root, valid());
    expect(res).toMatchObject({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(path.join(existing, 'expert.md'), 'utf8')).toBe('hand written');
    expect(fs.readdirSync(root)).toEqual(['uk-cold-email']);
  });

  it('refuses an invalid draft and writes nothing', () => {
    const res = writeExpertDraft(root, { ...valid(), slug: '../escape' });
    expect(res).toMatchObject({ ok: false, reason: 'invalid' });
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, '..', 'escape'))).toBe(false);
  });
});
