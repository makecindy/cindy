/**
 * Generates a concise label for an after-edit snapshot.
 *
 * Snapshot creation remains code-determined; the injected oneShot call is only
 * used after createSnapshot has confirmed that staged changes exist.
 */

import type { StagedDiff } from "./gitSnapshotService.js";
import { redactSecrets } from "./secretRedactor.js";

export interface AfterEditLabelInput {
  diff: StagedDiff;
  userPrompt?: string;
}

export interface AfterEditLabelDeps {
  oneShot: (prompt: string) => Promise<string>;
}

const PROMPT_DIFF_TEXT_MAX = 4_000;
const PROMPT_USER_PROMPT_MAX = 200;
const LABEL_MAX_CHARS = 30;
const WRAP_CHARS = new Set(['"', "'", "`", "「", "」", "“", "”", "《", "》"]);

/** Builds the oneShot prompt from redacted diff context and optional user intent. */
export function buildAfterEditPrompt(input: AfterEditLabelInput): string {
  const redactedDiff = redactSecrets(input.diff.diffText);
  const diffText =
    redactedDiff.length > PROMPT_DIFF_TEXT_MAX
      ? `${redactedDiff.slice(0, PROMPT_DIFF_TEXT_MAX)}\n...[truncated]`
      : redactedDiff;
  const parts = [
    "根据以下代码改动, 用一句简短中文描述这次改动做了什么。",
    "要求: 动词开头, 不超过20字, 不要引号, 不要句号, 直接输出一句话, 不要解释。",
  ];
  const userPrompt = input.userPrompt?.trim();
  if (userPrompt) {
    parts.push(
      `\n[本轮用户请求, 仅供参考]:\n${redactSecrets(userPrompt).slice(0, PROMPT_USER_PROMPT_MAX)}`,
    );
  }
  parts.push(`\n[改动文件]:\n${input.diff.diffStat.trim()}`);
  parts.push(`\n[改动内容]:\n${diffText}`);
  return parts.join("\n");
}

/** Cleans model output into a single commit-label line. */
export function sanitizeLabel(raw: string): string {
  let s =
    (raw ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.trim();
    if (s && WRAP_CHARS.has(s[0])) s = s.slice(1);
    if (s && WRAP_CHARS.has(s[s.length - 1])) s = s.slice(0, -1);
    s = s.replace(/[。.!！?？、，,；;]+$/u, "");
  }
  if (s.length > LABEL_MAX_CHARS) s = s.slice(0, LABEL_MAX_CHARS);
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

function parseChangedFiles(diffStat: string): string[] {
  const seen = new Set<string>();
  return diffStat
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("|");
      if (idx <= 0) return "";
      const filePath = line.slice(0, idx).trim();
      return filePath.split("/").pop()?.split("\\").pop() ?? filePath;
    })
    .filter(
      (name): name is string =>
        Boolean(name) && !seen.has(name) && seen.add(name) !== undefined,
    );
}

/** Deterministic fallback used when oneShot fails or returns an unusable label. */
export function deterministicLabel(diffStat: string): string {
  const files = parseChangedFiles(diffStat);
  if (files.length === 0) return "保存改动";
  if (files.length === 1) return `改动 ${files[0]}`;
  return `改动 ${files.length} 个文件: ${files.slice(0, 2).join(", ")}`;
}

/** Creates an after-edit snapshot label and never throws. */
export async function createAfterEditLabel(
  input: AfterEditLabelInput,
  deps: AfterEditLabelDeps,
): Promise<string> {
  try {
    const clean = sanitizeLabel(
      await deps.oneShot(buildAfterEditPrompt(input)),
    );
    if (clean) return clean;
  } catch {
    // Snapshot creation should not depend on best-effort label generation.
  }
  return deterministicLabel(input.diff.diffStat);
}
