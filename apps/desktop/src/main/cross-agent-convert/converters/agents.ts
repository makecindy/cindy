/**
 * agents converter: .claude/agents/<name>.md ↔ .codex/agents/<name>.toml
 *
 * Claude 端 (.md):
 *   ---
 *   name: foo
 *   description: bar
 *   tools: [Read, Write]
 *   model: sonnet
 *   ---
 *   <markdown body>
 *
 * Codex 端 (.toml) — 字段名严格按官方文档
 * (https://developers.openai.com/codex/subagents):
 *   name = "foo"
 *   description = "bar"
 *   developer_instructions = """<markdown body>"""
 *   model = "gpt-5.4"
 *   model_reasoning_effort = "high"
 *   sandbox_mode = "..."
 *
 * 字段映射(双向):
 *   Claude prompt body  ↔  Codex developer_instructions
 *   Claude reasoning_effort  ↔  Codex model_reasoning_effort
 *   Claude permission_mode  ↔  Codex sandbox_mode
 *
 * Model 字段不做术语替换,而是按 mapModel() 显式映射(claude haiku → gpt-5.4-mini 等)。
 *
 * 子项粒度处理:subItems 列出每个缺失的 agent,逐个独立转换。任意失败不阻塞其他。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import type { MigrationItem, MigrationStepStatus } from '../types.js';
import { rewriteTerms } from './term-rewrite.js';

export interface ConvertOutcome {
  status: MigrationStepStatus;
  detail?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

interface AgentFields {
  name?: string;
  description?: string;
  tools?: string[] | string;
  model?: string;
  // 其他字段透传
  [key: string]: unknown;
}

interface ParsedAgent {
  fields: AgentFields;
  body: string;
}

// ── Field name & model mapping ──────────────────────────────────────────────

const FIELD_RENAME_TO_CODEX: Record<string, string> = {
  reasoning_effort: 'model_reasoning_effort',
  permission_mode: 'sandbox_mode',
};
const FIELD_RENAME_TO_CLAUDE: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_RENAME_TO_CODEX).map(([k, v]) => [v, k]),
);

/** Model 不允许参与术语替换:rewriteFields 跳过它,由 mapModel 显式翻译。 */
const MODEL_FIELD = 'model';

// TODO(unified-model-catalog): keep cross-runtime model mapping here until crossRuntimeMapping metadata lands.
/**
 * Claude → Codex model mapping.
 * 取自 packages/maker-core/src/agents/claude-code/index.ts (CLAUDE_MODELS)
 *  与 packages/maker-core/src/agents/codex/index.ts (CODEX_MODELS)。
 *
 * 哲学:同档位互转(top-tier → top-tier,lightweight → lightweight)。
 * 未知值 → 退化到目标端最强模型。
 */
function mapModelToCodex(claudeModel: string): string {
  const m = claudeModel.toLowerCase();
  // Haiku / mini → mini
  if (m.includes('haiku') || m.includes('mini')) return 'gpt-5.4-mini';
  // Opus / Sonnet / 其他 → top-tier
  return 'gpt-5.4';
}

function mapModelToClaude(codexModel: string): string {
  const m = codexModel.toLowerCase();
  // mini / spark → haiku (lightweight)
  if (m.includes('mini') || m.includes('spark')) return 'claude-haiku-4-5';
  // gpt-5.5 / gpt-5.4 / 其他 → top-tier
  return 'claude-opus-4-7';
}

// ── Parse / render ──────────────────────────────────────────────────────────

function parseClaudeMd(raw: string): ParsedAgent {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    return { fields: {}, body: raw };
  }
  const yamlText = m[1];
  const body = m[2] ?? '';
  let fields: AgentFields = {};
  try {
    const parsed = yaml.load(yamlText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fields = parsed as AgentFields;
    }
  } catch {
    // YAML parse fail → 退化为没有 frontmatter
  }
  return { fields, body };
}

/**
 * 递归对 string 值做术语替换。
 *  - `model` 字段跳过(由调用方用 mapModel 显式翻译)
 *  - 其他类型透传
 */
function rewriteFields(
  obj: Record<string, unknown>,
  direction: MigrationItem['direction'],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === MODEL_FIELD) {
      out[k] = v; // 不替换字符串内容,后面专门处理
      continue;
    }
    if (typeof v === 'string') {
      out[k] = rewriteTerms(v, direction);
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === 'string' ? rewriteTerms(x, direction) : x));
    } else if (v && typeof v === 'object') {
      out[k] = rewriteFields(v as Record<string, unknown>, direction);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 应用字段名重命名(reasoning_effort → model_reasoning_effort 等)。 */
function renameFields(
  obj: Record<string, unknown>,
  table: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[table[k] ?? k] = v;
  }
  return out;
}

function renderCodexToml(parsed: ParsedAgent, direction: 'to-codex'): string {
  let out = rewriteFields(parsed.fields as Record<string, unknown>, direction);
  out = renameFields(out, FIELD_RENAME_TO_CODEX);
  if (typeof parsed.fields.model === 'string' && parsed.fields.model.trim()) {
    out.model = mapModelToCodex(parsed.fields.model);
  }
  if (parsed.body.trim()) {
    // Claude 端的 markdown body → Codex 端的 developer_instructions
    out.developer_instructions = rewriteTerms(parsed.body, direction);
  }
  return stringifyToml(out);
}

function parseCodexToml(raw: string): ParsedAgent {
  let fields: AgentFields = {};
  try {
    const parsed = parseToml(raw);
    if (parsed && typeof parsed === 'object') {
      fields = parsed as AgentFields;
    }
  } catch {
    return { fields: {}, body: '' };
  }
  // 抽出 developer_instructions 当 body
  const body = typeof fields.developer_instructions === 'string' ? fields.developer_instructions : '';
  delete fields.developer_instructions;
  return { fields, body };
}

function renderClaudeMd(parsed: ParsedAgent, direction: 'to-claude'): string {
  let fmObj = rewriteFields(parsed.fields as Record<string, unknown>, direction);
  fmObj = renameFields(fmObj, FIELD_RENAME_TO_CLAUDE);
  if (typeof parsed.fields.model === 'string' && parsed.fields.model.trim()) {
    fmObj.model = mapModelToClaude(parsed.fields.model);
  }
  const yamlText = yaml.dump(fmObj).trimEnd();
  const body = rewriteTerms(parsed.body, direction);
  return `---\n${yamlText}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

async function convertOne(
  sourcePath: string,
  targetPath: string,
  direction: MigrationItem['direction'],
): Promise<MigrationStepStatus> {
  // 二次校验
  try {
    await fs.access(targetPath);
    return 'skipped';
  } catch {
    /* not exists, proceed */
  }

  const raw = await fs.readFile(sourcePath, 'utf8');

  let outContent: string;
  if (direction === 'to-codex') {
    const parsed = parseClaudeMd(raw);
    if (!parsed.fields.name) {
      // 无合法 name 视为 skipped(避免生成无效 TOML 文件)
      return 'skipped';
    }
    outContent = renderCodexToml(parsed, 'to-codex');
  } else {
    const parsed = parseCodexToml(raw);
    if (!parsed.fields.name) return 'skipped';
    outContent = renderClaudeMd(parsed, 'to-claude');
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.writeFile(targetPath, outContent, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'EEXIST') return 'skipped';
    throw err;
  }
  return 'success';
}

export async function convertAgents(item: MigrationItem): Promise<ConvertOutcome> {
  const subItems = item.subItems ?? [];
  if (subItems.length === 0) return { status: 'skipped', detail: '无新增子项' };

  let success = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const sub of subItems) {
    try {
      const st = await convertOne(sub.sourcePath, sub.targetPath, item.direction);
      if (st === 'success') success += 1;
      else if (st === 'skipped') skipped += 1;
    } catch (err) {
      failed += 1;
      failures.push(`${sub.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failed > 0) {
    return {
      status: 'failed',
      detail: `成功 ${success}, 跳过 ${skipped}, 失败 ${failed} (${failures.slice(0, 2).join('; ')})`,
    };
  }
  if (success === 0) return { status: 'skipped', detail: `全部 ${skipped} 项已存在或不可解析` };
  return {
    status: 'success',
    detail: skipped > 0 ? `新增 ${success} 项,跳过 ${skipped} 项` : `新增 ${success} 项`,
  };
}
