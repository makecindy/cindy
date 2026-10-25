/**
 * Frontmatter schema validation for in-app .md editing.
 *
 * Lives in main so the renderer doesn't have to bundle gray-matter (which
 * trips Rollup's eval warning and previously caused browser/Node behavior
 * divergence — see SkillhubDetailView 注释).
 *
 * Each rule set validates known fields for a given .md kind. Unknown fields
 * pass through silently — the editor stays permissive (the user can add
 * any YAML key), we only flag malformed values for fields we know about.
 */

import matter from 'gray-matter';

export type MdKind = 'skill' | 'command' | 'agent' | 'sibling';

export interface FrontmatterIssue {
  field: string;
  message: string;
}

interface FieldRule {
  required?: boolean;
  /** Validate the parsed value. Return error message or null. */
  validate?: (value: unknown) => string | null;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const SKILL_RULES: Record<string, FieldRule> = {
  // SKILL.md per Claude Code spec — name + description are the only required
  // fields; the rest are descriptive metadata that the loader tolerates
  // missing.
  name: {
    required: true,
    validate: (v) =>
      isNonEmptyString(v) ? null : 'name 必填,且为非空字符串',
  },
  description: {
    required: true,
    validate: (v) =>
      isNonEmptyString(v) ? null : 'description 必填,且为非空字符串',
  },
  version: {
    validate: (v) =>
      v == null || typeof v === 'string' || typeof v === 'number'
        ? null
        : 'version 应为字符串或数字',
  },
};

const COMMAND_RULES: Record<string, FieldRule> = {
  // Commands are simpler — description is conventional but not strictly
  // required by Claude Code (the body itself is the prompt).
  description: {
    validate: (v) =>
      v == null || isNonEmptyString(v)
        ? null
        : 'description 应为非空字符串(或省略)',
  },
};

function rulesFor(kind: MdKind): Record<string, FieldRule> | null {
  if (kind === 'skill') return SKILL_RULES;
  if (kind === 'command') return COMMAND_RULES;
  // agent / sibling — no enforced schema. v0.2.2 doesn't ship agent edit;
  // sibling .md files inside a skill don't have a known schema.
  return null;
}

function validateParsed(
  frontmatter: Record<string, unknown> | null | undefined,
  kind: MdKind,
): FrontmatterIssue[] {
  const rules = rulesFor(kind);
  if (!rules) return [];
  const issues: FrontmatterIssue[] = [];
  const fm = frontmatter ?? {};
  for (const [field, rule] of Object.entries(rules)) {
    const value = fm[field];
    if (rule.required && (value == null || value === '')) {
      issues.push({ field, message: `${field} 必填` });
      continue;
    }
    if (rule.validate) {
      const msg = rule.validate(value);
      if (msg) issues.push({ field, message: msg });
    }
  }
  return issues;
}

/**
 * Parse YAML frontmatter from raw .md content and validate it against the
 * rules for the given kind. Parser failures collapse to "no issues" — the
 * editor's purpose is to let the user fix things, not block saves.
 */
export function parseAndValidateFrontmatter(
  content: string,
  kind: MdKind,
): { issues: FrontmatterIssue[] } {
  let data: Record<string, unknown> | null = null;
  try {
    data = (matter(content).data as Record<string, unknown>) ?? null;
  } catch {
    return { issues: [] };
  }
  return { issues: validateParsed(data, kind) };
}
