/**
 * TOC renderer + writer.
 *
 * Generates `.cindy/project-knowledge/TOC.md`, a pre-rendered index of all
 * module/concern knowledge files plus per-entry short summaries. Consumers use
 * it as the stable on-demand entrypoint; Cindy Desktop injects only its path at
 * session-create time instead of preloading the full body.
 *
 * Why pre-render (vs. dynamic extraction in the consumer):
 *   - Knowledge files are themselves CI-generated artifacts (update / refresh
 *     run on a single bot machine, output committed to git). TOC.md follows the
 *     exact same lifecycle: regenerated alongside .md, committed to git,
 *     distributed to users via pull. No drift, no per-user IO at session start.
 *   - PR review surfaces summary regressions (e.g. agent leaking meta-narration
 *     into "是什么") in the TOC.md diff, before users see bad data.
 *   - Consumers stay trivial: confirm TOC.md exists, then expose its stable path.
 *
 * Source of truth for each summary is the FIRST PARAGRAPH of the `## 是什么` H2
 * section in the module's .md. If that section is missing or empty, the entry
 * is rendered with a "(摘要缺失)" placeholder — explicit signal of a knowledge
 * file that doesn't follow the contract, rather than silently substituting some
 * other paragraph (which historically captured leaked meta-narration).
 */

import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import { CONTEXT_DIR, type ResolvedPaths } from './config.js';
import { readManifest } from './manifest.js';

/** Output TOC byte cap. ~2.5k tokens. Beyond this we truncate summaries (table kept). */
const MAX_TOC_BYTES = 10 * 1024;
/** Per-entry summary char cap. ~120 Chinese chars. */
const SUMMARY_MAX_CHARS = 240;

export interface RenderTocResult {
  body: string;
  truncated: boolean;
  /** Entry count actually rendered (may be fewer than manifest if entries lack id/path). */
  entries: number;
}

/**
 * Read manifest + each knowledge .md, render the TOC markdown body. Does not
 * include any transport wrapper (e.g. XML tag) — that is the consumer's choice.
 */
export function renderToc(paths: ResolvedPaths): RenderTocResult {
  const manifest = readManifest(paths.manifestPath);
  const entries = manifest.entries ?? [];

  type Row = {
    id: string;
    coversCell: string;
    relPathPosix: string;
    stale: boolean;
    summary: string;
  };
  const rows: Row[] = [];

  for (const entry of entries) {
    if (!entry.id || !entry.path) continue;
    const mdPath = path.join(paths.contextDir, entry.path.replace(/\//g, path.sep));
    let summary = '';
    try {
      const raw = fs.readFileSync(mdPath, 'utf8');
      summary = extractSummary(raw);
    } catch {
      // Missing/unreadable file — leave summary empty; downstream renders "(摘要缺失)".
    }
    const coversCell = (entry.covers ?? []).map((c) => `\`${c}\``).join(', ') || '—';
    const relPathPosix = path.posix.join(CONTEXT_DIR, entry.path.replace(/\\/g, '/'));
    rows.push({
      id: entry.id,
      coversCell,
      relPathPosix,
      stale: !!entry.stale,
      summary,
    });
  }

  const { body, truncated } = assembleBody(rows);
  return { body, truncated, entries: rows.length };
}

/**
 * Render + atomic-write TOC.md to `paths.tocPath`. Returns the result. Safe to
 * call from init/update/refresh after manifest has been written.
 */
export function writeToc(paths: ResolvedPaths): RenderTocResult {
  const result = renderToc(paths);
  const tmpPath = `${paths.tocPath}.tmp`;
  fs.mkdirSync(path.dirname(paths.tocPath), { recursive: true });
  fs.writeFileSync(tmpPath, result.body, 'utf8');
  fs.renameSync(tmpPath, paths.tocPath);
  return result;
}

/**
 * Extract the first paragraph of `## 是什么` (Chinese). Returns empty string when
 * the section is absent or its first paragraph is empty — caller decides how to
 * present that (we standardize on a visible "(摘要缺失)" placeholder).
 *
 * Truncation prefers a sentence boundary (。；; .) before the cap.
 */
function extractSummary(raw: string): string {
  let body: string;
  try {
    body = matter(raw).content;
  } catch {
    body = raw;
  }

  const lines = body.split(/\r?\n/);
  let section: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s+是什么\s*$/.test(line.trim())) {
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (/^##\s/.test(next.trim())) break;
        collected.push(next);
      }
      section = collected;
      break;
    }
  }
  if (!section) return '';

  const firstPara: string[] = [];
  let started = false;
  for (const line of section) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (started) break;
      continue;
    }
    started = true;
    firstPara.push(trimmed);
  }
  const text = firstPara.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const slice = text.slice(0, SUMMARY_MAX_CHARS);
  const punctMatch = slice.match(/^(.*[。；;\.])[^。；;\.]*$/);
  return (punctMatch?.[1] ?? slice) + '…';
}

function assembleBody(
  rows: Array<{
    id: string;
    coversCell: string;
    relPathPosix: string;
    stale: boolean;
    summary: string;
  }>,
): { body: string; truncated: boolean } {
  const header =
    '# Project Knowledge TOC\n\n' +
    '_Auto-generated by `project-context` (init / update / refresh). Do not edit by hand — re-run a `pctx` command to regenerate. Module summaries are extracted verbatim from each .md\'s first paragraph under `## 是什么`._\n\n' +
    '本项目的模块知识索引。**需要某个模块的细节时，用 Read 工具读对应路径的 .md 文件**；不涉及的模块不要主动读取。\n\n' +
    '| 模块 | 覆盖范围 | 索引文件 |\n' +
    '|---|---|---|';

  const tableRows: string[] = [];
  const summaries: string[] = [];
  for (const r of rows) {
    const staleTag = r.stale ? ' ⚠️stale' : '';
    tableRows.push(`| **${r.id}**${staleTag} | ${r.coversCell} | \`${r.relPathPosix}\` |`);
    summaries.push(
      r.summary
        ? `**${r.id}** — ${r.summary}`
        : `**${r.id}** — _（摘要缺失：该 .md 未按契约提供 \`## 是什么\` 段；Read 文件查看实际内容）_`,
    );
  }

  let body = `${header}\n${tableRows.join('\n')}\n\n## 模块摘要\n\n${summaries.join('\n\n')}\n`;
  if (Buffer.byteLength(body, 'utf8') <= MAX_TOC_BYTES) {
    return { body, truncated: false };
  }

  // Over cap: drop summary entries from the tail; keep the full table (it's the
  // path index agents use to locate files).
  while (summaries.length > 0 && Buffer.byteLength(body, 'utf8') > MAX_TOC_BYTES) {
    summaries.pop();
    body =
      `${header}\n${tableRows.join('\n')}\n\n## 模块摘要\n\n${summaries.join('\n\n')}\n\n` +
      `_（部分摘要因体积上限被省略，Read 对应 .md 文件可看完整内容）_\n`;
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_TOC_BYTES) {
    body =
      `${header}\n${tableRows.join('\n')}\n\n` +
      `_（所有摘要因体积上限被省略，Read 对应 .md 文件查看模块详情）_\n`;
  }
  return { body, truncated: true };
}
