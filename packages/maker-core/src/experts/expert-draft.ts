/**
 * Expert drafts (ROADMAP 3.8, ADR 0005/0007).
 *
 * The expert creator proposes a new expert as a draft; the owner approves it before anything
 * is written (option A). This module is the file side: it checks a draft against the same rules
 * the loader enforces, renders `expert.md`, and writes a NEW expert folder atomically:
 * a hidden temp folder in the experts root is written, loaded back through the real loader,
 * and only then renamed into place. An existing expert is never overwritten.
 *
 * A draft cannot grant tools: the written expert has no `tools:` line, so an expert creator
 * can never create another expert creator. The owner adds tools by hand if they want them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

import { loadExpert } from './expert-loader';

/** Lowercase kebab-case folder name, 2–64 characters. */
const DRAFT_SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const EXPERT_DRAFT_LIMITS = {
  name: 80,
  description: 300,
  model: 120,
  tags: 10,
  tag: 40,
  prompt: 20_000,
} as const;

export interface ExpertDraft {
  slug: string;
  name: string;
  description: string;
  /** Route name from routing.yaml, or a model id. Omitted: runs on whatever model the session uses. */
  model?: string;
  tags: string[];
  memory: boolean;
  /** The system prompt (body of expert.md). */
  prompt: string;
}

export type ExpertDraftCheck = { ok: true; draft: ExpertDraft } | { ok: false; errors: string[] };

function oneLine(value: string): boolean {
  return !/[\r\n]/.test(value);
}

/** Check untrusted input (a tool call) and normalise it into a draft. Never throws. */
export function validateExpertDraft(input: unknown): ExpertDraftCheck {
  const errors: string[] = [];
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const L = EXPERT_DRAFT_LIMITS;

  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  if (!DRAFT_SLUG.test(slug)) {
    errors.push('"slug" must be 2-64 characters of lowercase letters, digits and dashes, starting with a letter or digit (e.g. "uk-cold-email-writer")');
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) errors.push('"name" is required');
  else if (name.length > L.name || !oneLine(name)) errors.push(`"name" must be one line of at most ${L.name} characters`);

  let description = '';
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== 'string') errors.push('"description" must be a string');
    else description = raw.description.trim();
  }
  if (!description) errors.push('"description" is required (one sentence saying what the expert does)');
  else if (description.length > L.description || !oneLine(description)) {
    errors.push(`"description" must be one line of at most ${L.description} characters`);
  }

  let model: string | undefined;
  if (raw.model !== undefined && raw.model !== null && raw.model !== '') {
    if (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.trim().length > L.model || !oneLine(raw.model)) {
      errors.push(`"model" must be a route name of at most ${L.model} characters, or omitted`);
    } else {
      model = raw.model.trim();
    }
  }

  let tags: string[] = [];
  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === 'string' && t.trim() && t.trim().length <= L.tag && oneLine(t))) {
      errors.push(`"tags" must be a list of short words (each at most ${L.tag} characters)`);
    } else if (raw.tags.length > L.tags) {
      errors.push(`"tags" holds at most ${L.tags} entries`);
    } else {
      tags = [...new Set((raw.tags as string[]).map((t) => t.trim()))];
    }
  }

  let memory = false;
  if (raw.memory !== undefined && raw.memory !== null) {
    if (typeof raw.memory !== 'boolean') errors.push('"memory" must be true or false');
    else memory = raw.memory;
  }

  if (raw.tools !== undefined || (raw.agent !== undefined && raw.agent !== 'hermes')) {
    errors.push('drafts cannot set "tools" or a non-Hermes "agent"; the owner adds those by hand');
  }

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) errors.push('"prompt" (the expert\'s system prompt) is required');
  else if (prompt.length > L.prompt) errors.push(`"prompt" is ${prompt.length} characters; the limit is ${L.prompt}`);
  else if (/^---\s*$/m.test(prompt.split('\n')[0] ?? '')) errors.push('"prompt" must not start with a "---" line');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, draft: { slug, name, description, ...(model ? { model } : {}), tags, memory, prompt } };
}

/** The exact `expert.md` an approved draft becomes. */
export function renderExpertMarkdown(draft: ExpertDraft): string {
  const data: Record<string, unknown> = {
    name: draft.name,
    description: draft.description,
    agent: 'hermes',
    ...(draft.model ? { model: draft.model } : {}),
    memory: draft.memory,
    ...(draft.tags.length > 0 ? { tags: draft.tags } : {}),
  };
  // lineWidth -1: one line per field, so the owner can hand-edit it (no folded `>-` blocks).
  const text = matter.stringify(`${draft.prompt}\n`, data, { lineWidth: -1 } as Parameters<typeof matter.stringify>[2]);
  return text.endsWith('\n') ? text : `${text}\n`;
}

export type WriteExpertDraftResult =
  | { ok: true; dir: string; file: string }
  | { ok: false; reason: 'exists' | 'invalid'; message: string };

export function expertDraftExists(rootDir: string, slug: string): boolean {
  try {
    fs.lstatSync(path.join(rootDir, slug));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write an approved draft as `<rootDir>/<slug>/expert.md`. All or nothing: on any failure the
 * temp folder is removed and nothing under `<rootDir>/<slug>` is created or changed.
 */
export function writeExpertDraft(rootDir: string, draft: ExpertDraft, opts: { now?: () => number } = {}): WriteExpertDraftResult {
  const check = validateExpertDraft(draft);
  if (!check.ok) return { ok: false, reason: 'invalid', message: check.errors.join('; ') };
  const clean = check.draft;
  const target = path.join(rootDir, clean.slug);
  if (expertDraftExists(rootDir, clean.slug)) {
    return { ok: false, reason: 'exists', message: `an expert folder "${clean.slug}" already exists; nothing was overwritten` };
  }

  fs.mkdirSync(rootDir, { recursive: true });
  // Dot-prefixed: the loader and the picker ignore it while it exists.
  const tmp = path.join(rootDir, `.${clean.slug}.draft-${process.pid}-${(opts.now ?? Date.now)()}`);
  try {
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(tmp, 'expert.md'), renderExpertMarkdown(clean), { flag: 'wx' });
    const loaded = loadExpert(tmp);
    if (!loaded.expert) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { ok: false, reason: 'invalid', message: `the draft does not load: ${loaded.error ?? 'unknown error'}` };
    }
    if (expertDraftExists(rootDir, clean.slug)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { ok: false, reason: 'exists', message: `an expert folder "${clean.slug}" already exists; nothing was overwritten` };
    }
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      return { ok: false, reason: 'exists', message: `an expert folder "${clean.slug}" already exists; nothing was overwritten` };
    }
    throw error;
  }
  return { ok: true, dir: target, file: path.join(target, 'expert.md') };
}
