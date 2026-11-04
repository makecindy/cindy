/**
 * pi-live-compact — 边做边压 (Live Compact) for pi 1.4.0.
 *
 * Port of MerkyorLynn/dsh-live-compact 1.0.1 (MIT) from the DeepSeek Harness (DSH)
 * plugin API onto the pi extension API. Feature parity with upstream 1.0.1:
 *   - Idle cut: after every completed agent run, if total context > SPINE_MIN_TOKENS
 *     (default 20000) and < BIG_GATE (650000), select the newest finished span
 *     (≤ RAIL_TOKENS 32000, user-message bounded, tool-pairing balanced, card
 *     verdict TRUNK CONFIRMED) and replace it in context with a local regex card —
 *     no model call, prefix untouched, prompt cache preserved.
 *   - Original text is shadowed to SPINE_SHADOW_DIR (default ~/.pi/compaction-spine/shadow).
 *   - Never grows: if the framed summary estimates >= the shadowed span, abort the cut.
 *   - Thunder path (SPINE_THUNDER=1): when pi's stock threshold compaction finally
 *     fires, decideThunder() compares shared prefix ratio; "send-less" re-summarizes
 *     a slimmed input via pi's own generateSummaryWithUsage instead of the full span.
 *
 * Mapping notes (DSH -> pi):
 *   - agent/status idle + turn/end completed  -> pi.on("agent_before_settle", outcome === "completed")
 *   - session.surface.nodes + surfaceOp replace -> event.context.contextEntries +
 *     context_edit drafts (omission per entry) + one custom_message draft
 *     (convertToLlm renders custom messages as user messages, matching DSH's
 *     checkpoint user message; appended at branch tip, which for a tail span is
 *     the same model-visible position modulo the kept live tail).
 *   - ctx.tokenMeter.measure                  -> ctx.getContextUsage().tokens with
 *     per-message estimateTokens() fallback (pi's own estimator).
 *   - toolPairingBalancedBefore/After         -> prefix/suffix tool-call/result set balance
 *     (prefix and suffix internally balanced => the span cannot separate a call
 *     from its result in either direction).
 *   - DSH compaction/start|summary|end lifecycle events -> custom_message.details
 *     bookkeeping (pi has no per-span compaction entry type; CompactionEntry can
 *     only fold a prefix, not a middle span).
 *   - state.localOnly/approvedCard summarize() interception -> not needed: the cut
 *     path uses the selection-time card directly and never routes through pi's
 *     compaction machinery.
 *
 * Env knobs (upstream-compatible): SPINE_MIN_TOKENS, SPINE_SHADOW_DIR,
 * SPINE_THUNDER, SPINE_THUNDER_MODEL ("27b" | "flash").
 * Logging: stderr lines prefixed "[pi-live-compact]" (grep "spine cut"), plus an
 * append-only spine.log next to the shadow directory for test verification.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  estimateTokens as estimateMessageTokens,
  generateSummaryWithUsage,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// plan.js — verbatim from dsh-live-compact 1.0.1 (plain JS, no deps)
// ---------------------------------------------------------------------------

const MARK = "Spine extract.";
const KEEP_BUDGET = 8000;
// 原仓不清理 shadow,长会话会无限堆积(实测 26 个 / 996K)。这里按「最近 N 个 + 总字节上限」
// 双闸清理,两个上限都可用环境变量覆盖。卡片里引用了已被删的路径时,模型 read 会失败。
const SHADOW_MAX_FILES = Number(process.env.SPINE_SHADOW_MAX_FILES || 100);
const SHADOW_MAX_BYTES = Number(process.env.SPINE_SHADOW_MAX_BYTES || 32 * 1024 * 1024);
const SHADOW_MAX_SESSIONS = Number(process.env.SPINE_SHADOW_MAX_SESSIONS || 20);
// spine.log 是纯 append,长会话会一直涨。按大小轮转,保留 N 个备份,总占用 ≤ (N+1)×上限。
const SPINE_LOG_MAX_BYTES = Number(process.env.SPINE_LOG_MAX_BYTES || 1024 * 1024);
const SPINE_LOG_KEEP = Number(process.env.SPINE_LOG_KEEP || 3);
const RAIL_TOKENS = 32000;
const TRUNK_SCOPE = "dynamic-v1";
const LINE_TEST = 240;
const CODE = /^(?:diff --git|index [0-9a-f]{4,}|@@ |--- |\+\+\+ |def |class |function |fn |pub |impl |import |export |#include |package |const |let |var |async |return |Traceback\b|Error:|Exception:|panic!|FAILED\b|PASS\b)|^\s+at \S+|^(?:\$ |> )?(?:git|cargo|npm|bun|python3|pip|curl|make) /;
const PATH = /^[~./\w-]+\.(?:py|js|ts|tsx|go|rs|java|c|h|cc|cpp|md|json|yml|yaml)(?::\d+)?$/;
const RESEARCH = /(?:\barxiv:\d{4}\.\d{4,5}\b|\bdoi:\s*10\.\d{4,}\/|\b10\.\d{4,9}\/\S+|\b(?:lr|learning_rate|batch_size|temperature|top_p|max_tokens)\s*[=:]|^\$\$|\\(?:frac|sum|prod|alpha|beta|gamma|cdot)\b|^Figure \d|^Table \d|^Eq\.?\s*\d|\bsha256\b|\b[a-f0-9]{64}\b)/i;
const TABLE = /^\|.*\|$/;
const HARNESS = /web_search results are external|web_fetch returns external|Track every background job|Use the workflow tool ONLY|create_goal may infer|do not busy-poll/;
const OBLIGATION = /(?:\b(?:must|never|do not|don't|required|requires|preserve|preserving|shall not)\b|必须|不要|禁止|不能|不得|只能|保留)/i;
const TOKEN = /`([^`]{2,80})`|\b([A-Z][A-Za-z0-9]+(?:[A-Z][a-z0-9]+)+)\b|\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+)\b|\b([a-z][a-z0-9]*(?:[_-][a-z0-9]+){1,})\b|\b([A-Za-z0-9_.-]+\.(?:py|js|ts|tsx|go|rs|java|c|h|cc|cpp|md|json|yml|yaml))\b|\b((?:~|\.{1,2})?\/[A-Za-z0-9_./+-]{3,})\b/g;
const IDENT_VERB = /`[^`]{2,80}`[\s\S]{0,80}\b(?:move|place|clear|preserve|require|requires|keep)\b|\b(?:move|place|clear|preserve|require|requires|keep)\b[\s\S]{0,80}`[^`]{2,80}`/i;
const ERROR_LINE = /^(?:Error:|Exception:|Traceback\b|FAILED\b|panic!)/;

function isPadding(text: any) {
  if (!text) return false;
  const sample = text.length > 800 ? text.slice(0, 800) : text;
  const parts = sample.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 8) return false;
  const counts = new Map();
  let max = 0;
  for (const part of parts) {
    const next = counts.get(part) || 0;
    counts.set(part, next);
    if (next > max) max = next;
  }
  return counts.size <= 3 || max / parts.length >= 0.6;
}

function probe(line: any) {
  const sample = line.length > LINE_TEST ? line.slice(0, LINE_TEST) : line;
  return CODE.test(sample) || PATH.test(sample) || RESEARCH.test(sample) || TABLE.test(sample);
}

function repeatedNames(text: any) {
  const counts = new Map();
  for (const match of String(text || "").matchAll(TOKEN)) {
    const token = match.slice(1).find(Boolean);
    if (!token || token.length < 4) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]: any) => count >= 2).map(([token]: any) => token));
}

function compactionRoute(plan: any) {
  const chars = Math.max(1, plan?.chars || 0);
  const uncovered = plan?.uncovered?.length || 0;
  const proseRatio = uncovered / chars;
  if (uncovered >= 20000 && proseRatio >= 0.5) return "wait-80";
  if (uncovered < 20000 && proseRatio < 0.2) return "local";
  return "wait-80";
}

function planText(text: any) {
  const covered: any[] = [];
  const uncovered: any[] = [];
  let fence: any = null;
  let codeLines = 0;
  const flushFence = () => {
    if (!fence) return;
    codeLines += fence.length;
    const body = fence.join("\n");
    covered.push(body.length > 1200 ? `${fence[0]}\n… ${fence.length} code lines …\n${fence.at(-1)}` : body);
    fence = null;
  };
  for (const raw of String(text).split("\n")) {
    const trimmed = raw.trim();
    if (fence) {
      fence.push(raw);
      if (trimmed.startsWith("```")) flushFence();
      continue;
    }
    if (trimmed.startsWith("```")) {
      fence = [raw];
      continue;
    }
    if (!trimmed || isPadding(trimmed)) continue;
    if (probe(trimmed)) {
      codeLines += 1;
      covered.push(trimmed.length > 300 ? `${trimmed.slice(0, 180)} …` : trimmed);
    } else uncovered.push(trimmed);
  }
  flushFence();
  return { covered, uncovered: uncovered.join("\n"), codeLines };
}

function hardItems(text: any) {
  const names = repeatedNames(text);
  const items: any[] = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || HARNESS.test(line)) continue;
    const named = [...names].filter((name) => line.includes(name));
    if (line.length > 400) {
      items.push(...named);
      continue;
    }
    if (named.length > 0 || OBLIGATION.test(line) || ERROR_LINE.test(line) || IDENT_VERB.test(line) || PATH.test(line)) {
      items.push(line);
    }
  }
  return [...new Set(items)];
}

function cardBudgetFor(span: string): number {
  // pi 的 toolResult 是完整文件(带行号),硬行规模远大于 DSH 的摘要;中文文档更极端:
  // OBLIGATION 会命中「必须/不要/禁止」几乎每一行,硬行可占 span 的七成以上。
  // 固定 8K 只差几百字符就整刀放弃。预算随 span 放大,上限对齐 CHUNK_MAX(RAIL_TOKENS)。
  return Math.min(Math.max(KEEP_BUDGET, Math.ceil(span.length * 0.9)), RAIL_TOKENS);
}

function buildCard(spanText: any, liveText: any = "", budget: number = KEEP_BUDGET) {
  const span = String(spanText || "");
  const live = String(liveText || "");
  const hard = hardItems(span);
  const split = planText(span);
  const kept: any[] = [];
  let used = 0;
  let omittedHard = 0;
  for (const line of hard) {
    if (live.includes(line)) continue;
    if (used + line.length > budget) {
      omittedHard += 1;
      continue;
    }
    kept.push(line);
    used += line.length;
  }
  let deferred = 0;
  for (const line of [...new Set(split.covered)]) {
    if (kept.includes(line) || live.includes(line)) continue;
    if (used + line.length > budget) {
      deferred += 1;
      continue;
    }
    kept.push(line);
    used += line.length;
  }
  const missing = hard.filter((line: any) => !live.includes(line) && !kept.includes(line));
  const verdict = missing.length === 0 ? "TRUNK CONFIRMED" : "TRUNK UNCONFIRMED";
  return {
    verdict,
    scope: TRUNK_SCOPE,
    hardLines: hard,
    hardCount: hard.length,
    omittedHard,
    deferred,
    missing,
    uncovered: split.uncovered,
    keptChars: used,
    text: [
      MARK,
      `${verdict} against ${TRUNK_SCOPE}.`,
      "Checked: names repeated in this chunk, obligation lines, and error headers. Unclassified prose is not claimed.",
      `Hard lines: ${hard.length}. Missing from card and live context: ${missing.length}. Deferred recoverable: ${deferred}.`,
      "Kept lines:",
      ...(kept.length === 0 ? ["- (none)"] : kept.map((line) => `- ${line}`)),
      "A shadow path is not live preservation. Read a deferred file before using it.",
    ].join("\n"),
  };
}

function planMessages(messages: any[]) {
  const covered: any[] = [];
  const uncovered: any[] = [];
  const shortUsers: any[] = [];
  let chars = 0;
  let codeLines = 0;
  for (const message of messages) {
    const text = messageText(message);
    chars += text.length;
    const role = message?.role ?? message?.message?.role;
    if (role === "user" && text.length > 0 && text.length <= 280 && !text.startsWith(MARK)) {
      shortUsers.push(text.trim());
      continue;
    }
    const split = planText(text);
    covered.push(...split.covered);
    codeLines += split.codeLines;
    if (split.uncovered) uncovered.push(split.uncovered);
  }
  const unique = [...new Set(covered)];
  const kept: any[] = [];
  let used = 0;
  let omitted = 0;
  for (const line of unique) {
    if (used + line.length > KEEP_BUDGET) {
      omitted += 1;
      continue;
    }
    kept.push(line);
    used += line.length;
  }
  const prose = uncovered.join("\n");
  const joined = (messages || []).map(messageText).join("\n");
  const card = buildCard(joined, shortUsers.join("\n"));
  return {
    chars,
    codeLines,
    keptChars: card.keptChars,
    omitted,
    omittedHard: card.omittedHard,
    deferred: card.deferred,
    verdict: card.verdict,
    hardLines: card.hardLines,
    needsModel: compactionRoute({ chars, uncovered: prose }) !== "local",
    route: compactionRoute({ chars, uncovered: prose }),
    uncovered: prose,
    text: [
      card.text,
      `Shadowed characters: ${chars}. Regex kept lines: ${kept.length}. Omitted over budget: ${omitted}.`,
      "Short user messages:",
      ...(shortUsers.length === 0 ? ["- (none)"] : shortUsers.map((line) => `- ${line}`)),
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// thunder.js — verbatim from dsh-live-compact 1.0.1
// ---------------------------------------------------------------------------

const PROSE_TOKEN_CAP = 32000;

function sharedPrefixLength(previous: any, next: any) {
  if (!previous || !next) return 0;
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  const step = 64;
  while (index + step <= limit && previous.slice(index, index + step) === next.slice(index, index + step)) index += step;
  while (index < limit && previous[index] === next[index]) index += 1;
  return index;
}

function decideThunder({ previous, next, modelKind, prefixTokens, attachMaxTokens = 80000 }: any) {
  if (!previous || !next) return "send-less";
  const shared = sharedPrefixLength(previous, next);
  const ratio = shared / Math.max(previous.length, 1);
  if (ratio < 0.9) return "send-less";
  if (modelKind === "27b" && (prefixTokens || 0) > attachMaxTokens) return "send-less";
  return "attach";
}

function estimateProseTokens(text: any) {
  const cjk = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil(cjk / 1.5 + (String(text).length - cjk) / 4);
}

function buildSendLess({ taskLine, uncovered, facts, proseTokens = PROSE_TOKEN_CAP }: any) {
  const kept = (facts || []).filter(Boolean);
  let prose = uncovered || "";
  if (estimateProseTokens(prose) > proseTokens) {
    let low = 0;
    let high = prose.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateProseTokens(prose.slice(0, mid)) <= proseTokens) low = mid;
      else high = mid - 1;
    }
    prose = prose.slice(0, low);
  }
  return [
    taskLine || "Continue the current task.",
    "Facts already copied locally:",
    ...(kept.length ? kept.map((fact: any) => `- ${fact}`) : ["- (none)"]),
    "Uncovered prose to summarize:",
    prose || "(none)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// index.js — DSH engine ported onto the pi extension API
// ---------------------------------------------------------------------------

const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";
const CHUNK_MIN = 1000;
const CHUNK_MAX = RAIL_TOKENS;
const BIG_GATE = 650000;
const URGENT_TOKENS = 48000;
const MAX_TAIL = 2200;
const parsedMinPressure = Number(process.env.SPINE_MIN_TOKENS || 20000);
// 非法环境值回退默认:NaN 会让门槛恒 false(功能静默关闭),负数/0 会让每次 settle 都动刀。
const MIN_PRESSURE = Number.isFinite(parsedMinPressure) && parsedMinPressure > 0 ? parsedMinPressure : 20000;
const MAX_TRACKED_SESSIONS = 64;
const DEFAULT_KEY = "__default__";
const SPINE_CUSTOM_TYPE = "pi-live-compact";

interface SpineEntry {
  id: string;
  entryType: string;
  role: string;
  text: string;
  /** Full text including toolCall arguments; shadow files only, never budgeted. */
  shadowText: string;
  est: number;
  /** Tool call ids issued by this entry (assistant toolCalls). */
  calls: string[];
  /** Tool call ids answered by this entry (toolResult.toolCallId). */
  results: string[];
  source: any;
}

interface SpineState {
  key: string;
  lastPrefix: string;
  lastPrefixTokens: number;
}

// 与原仓 eventText 一致:只取 text 块。toolCall 参数不进 span/live/hardItems——
// 一次 write 的整文件参数就能顶穿卡片预算,让这类轮次必然 TRUNK UNCONFIRMED。
function messageText(message: any): string {
  const content = message?.content ?? message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
}

// 计价用的完整文本:text + thinking + toolCall 参数,对应 pi 内部 estimateTokens2 的口径。
function budgetText(message: any): string {
  const content = message?.content ?? message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block?.text === "string") return block.text;
      if (typeof block?.thinking === "string") return block.thinking;
      if (block?.type === "toolCall") return `${block.name ?? "tool"}${JSON.stringify(block.arguments ?? {})}`;
      return "";
    })
    .join("\n");
}

// pi 的 estimateTokens 是 ceil(chars/4),对中文低估约 4 倍(原仓 tokenMeter 用真实计价,
// thunder.js 也用 CJK 感知估算,仓内有先例)。英文保持 pi 原值不动,只给 CJK 补差额:
// 每 4 个汉字 pi 记 1 token,真实约 1.5 字符/token,补 (1/1.5 - 1/4) ≈ 0.4167。
const CJK_TOKEN_RE = /[\u4e00-\u9fff]/g;
function estimateTokens(message: any): number {
  const base = estimateMessageTokens(message);
  const cjk = (budgetText(message).match(CJK_TOKEN_RE) || []).length;
  return base + Math.ceil(cjk * (2 / 3 - 1 / 4));
}

// shadow 是本地恢复用的完整副本,调用参数(命令、路径、写入内容)必须留下。
function messageShadowText(message: any): string {
  const content = message?.content ?? message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block?.text === "string") return block.text;
      if (block?.type === "toolCall") {
        const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
        return `${block.name ?? "tool"} ${args}`;
      }
      return "";
    })
    .join("\n");
}

const stateBySession = new Map<string, SpineState>();

function sessionKey(ctx: any): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : DEFAULT_KEY;
  } catch {
    return DEFAULT_KEY;
  }
}

function stateFor(ctx: any): SpineState {
  const key = sessionKey(ctx);
  let state = stateBySession.get(key);
  if (state) {
    stateBySession.delete(key);
    stateBySession.set(key, state);
    return state;
  }
  state = { key, lastPrefix: "", lastPrefixTokens: 0 };
  stateBySession.set(key, state);
  if (stateBySession.size > MAX_TRACKED_SESSIONS) {
    for (const [oldKey, old] of stateBySession) {
      if (stateBySession.size <= MAX_TRACKED_SESSIONS) break;
      if (oldKey === key) continue;
      stateBySession.delete(oldKey);
    }
  }
  return state;
}

/** 实例级根:dev / packaged 各一份,跨会话稳定(原仓对应 DSH_HOME)。 */
function spineRoot(): string {
  if (process.env.SPINE_SHADOW_DIR) return process.env.SPINE_SHADOW_DIR;
  // 原仓用 DSH_HOME(实例级);pi 的对应物是 PI_CODING_AGENT_DIR,但它是每会话的
  // <agentHome>/run-tmp/<hash>,会话结束就清 —— 放那里卡片里的路径会变成死链。
  // 取它的祖父目录(agentHome),既按实例隔离,又跨会话稳定。
  const configDir = process.env.PI_CODING_AGENT_DIR;
  if (configDir && isAbsolute(configDir)) {
    const parent = dirname(configDir);
    const root = basename(parent) === "run-tmp" ? dirname(parent) : configDir;
    return join(root, "compaction-spine");
  }
  return join(homedir(), ".pi", "compaction-spine");
}

/**
 * Shadow 只被「产生它的那个会话」的卡片引用:A 会话的卡片在 B 会话里不存在,
 * 所以 B 永远读不到 A 的 shadow。按会话分目录,淘汰也只在本会话内进行。
 */
function shadowDirectory(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "").slice(-40) || "session";
  return join(spineRoot(), "shadow", safe);
}

function shadowName(key: string, length: number): string {
  const tag = key.replace(/[^A-Za-z0-9_-]/g, "").slice(-24) || "session";
  return `${Date.now()}-${length}-${tag}-${randomBytes(4).toString("hex")}.txt`;
}

/**
 * Keep the newest SHADOW_MAX_FILES shadow files and cap total bytes.
 * Both limits apply; a file is deleted when either is exceeded. Best-effort:
 * a file that vanished between readdir and unlink is ignored.
 */
function pruneShadow(dir: string): void {
  try {
    const entries = readdirSync(dir)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => {
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          return { full, size: stat.size, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { full: string; size: number; mtime: number } => item !== null)
      .sort((left, right) => right.mtime - left.mtime);
    let total = 0;
    let kept = 0;
    for (const item of entries) {
      if (kept >= SHADOW_MAX_FILES || total + item.size > SHADOW_MAX_BYTES) {
        try {
          unlinkSync(item.full);
        } catch {}
        continue;
      }
      kept += 1;
      total += item.size;
    }
  } catch {}
}

/** Keep only the newest SHADOW_MAX_SESSIONS session directories. */
function pruneShadowSessions(root: string): void {
  try {
    const dirs = readdirSync(root)
      .map((name) => {
        const full = join(root, name);
        try {
          const stat = statSync(full);
          return stat.isDirectory() ? { full, mtime: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((item): item is { full: string; mtime: number } => item !== null)
      .sort((left, right) => right.mtime - left.mtime);
    dirs.slice(Math.max(1, SHADOW_MAX_SESSIONS)).forEach((item) => {
      try {
        rmSync(item.full, { recursive: true, force: true });
      } catch {}
    });
  } catch {}
}

/**
 * Size-based rotation: spine.log -> spine.log.1, .1 -> .2, ... oldest dropped.
 * Multiple pi processes may append to the same file; every step is best-effort
 * so a lost race costs at most a few log lines.
 */
function rotateLog(file: string): void {
  try {
    if (statSync(file).size < SPINE_LOG_MAX_BYTES) return;
  } catch {
    return; // no log yet
  }
  for (let index = SPINE_LOG_KEEP; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${index - 1}`;
    const to = `${file}.${index}`;
    try {
      rmSync(to, { force: true });
    } catch {}
    try {
      renameSync(from, to);
    } catch {}
  }
}

function logLine(state: SpineState, message: string): void {
  const line = `[pi-live-compact][${state.key.slice(-8)}] ${message}`;
  try {
    console.error(line);
  } catch {}
  try {
    const file = join(spineRoot(), "spine.log");
    rotateLog(file);
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/** Project pi's projected context entries into the flat spine entry list. */
function spineEntries(contextEntries: any[]): SpineEntry[] {
  const entries: SpineEntry[] = [];
  for (const projected of contextEntries || []) {
    const messages = projected?.messages ?? [];
    if (messages.length === 0) continue; // omitted or state-only
    let text = "";
    let shadowText = "";
    let est = 0;
    const calls: string[] = [];
    const results: string[] = [];
    let role = "";
    for (const message of messages) {
      text += (text ? "\n" : "") + messageText(message);
      shadowText += (shadowText ? "\n" : "") + messageShadowText(message);
      try {
        est += estimateTokens(message);
      } catch {
        est += Math.ceil(messageText(message).length / 4);
      }
      role = message?.role || role;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "toolCall" && typeof block.id === "string") calls.push(block.id);
        }
      }
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        results.push(message.toolCallId);
      }
    }
    const sourceType = String(projected?.sourceEntry?.type ?? "");
    entries.push({
      id: String(projected?.sourceEntry?.id ?? ""),
      entryType: sourceType,
      role,
      text,
      shadowText,
      est,
      calls,
      results,
      source: projected?.sourceEntry,
    });
  }
  return entries;
}

function isCheckpoint(entry: SpineEntry): boolean {
  if (entry.entryType === "compaction" || entry.entryType === "branch_summary") return true;
  if (entry.role === "custom") return true;
  return entry.text.includes(MARK);
}

function isUser(entry: SpineEntry): boolean {
  return entry.role === "user";
}

function cutOk(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/**
 * Prefix/suffix tool-pairing balance. With prefix [0..i-1] and suffix [j+1..last]
 * both internally balanced (every issued call answered within the same range), the
 * span [i..j] cannot separate a call from its result in either direction.
 */
function balanceIndexes(entries: SpineEntry[]) {
  const prefixBalanced: boolean[] = new Array(entries.length).fill(false);
  const suffixBalanced: boolean[] = new Array(entries.length).fill(false);
  const open = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    for (const id of entries[i].calls) open.add(id);
    for (const id of entries[i].results) open.delete(id);
    prefixBalanced[i] = open.size === 0;
  }
  open.clear();
  for (let i = entries.length - 1; i >= 0; i--) {
    for (const id of entries[i].results) open.add(id);
    for (const id of entries[i].calls) open.delete(id);
    suffixBalanced[i] = open.size === 0;
  }
  // suffixBalanced[i] == "range [i..last] is balanced"; a clean boundary after end
  // is suffixBalanced[end + 1] (with suffixBalanced[n] treated as true).
  return { prefixBalanced, suffixBalanced };
}

function describeEntries(entries: SpineEntry[]): string {
  return entries
    .map((e, i) => `${i}:${e.role || '?'}/${e.est}${e.calls.length ? 'c' + e.calls.length : ''}${e.results.length ? 'r' + e.results.length : ''}`
      + `${isCheckpoint(e) ? '*CK' : ''}`)
    .join(' ');
}

function selectNewestChunk(entries: SpineEntry[], diag?: (why: string) => void) {
  const warn = (why: string) => { diag?.(why); return null; };
  const nodes = entries.map((_, index) => index);
  if (nodes.length === 0) return warn('empty');
  // 原仓 first = 首个节点是 system 时从 1 开始:system 不应进入切割区,也不应成为下限。
  const first = entries[0]?.role === 'system' ? 1 : 0;
  const { prefixBalanced, suffixBalanced } = balanceIndexes(entries);
  const suffixClean = (end: number) => end + 1 >= entries.length || suffixBalanced[end + 1];

  let end = nodes.length - 1;
  while (end >= first) {
    const entry = entries[end];
    const shortTail = entry.role === "assistant" || (entry.role === "user" && entry.est < 400);
    if (!shortTail) break;
    end -= 1;
  }
  while (end >= first && isCheckpoint(entries[end])) end -= 1;
  while (end >= first && !cutOk(() => suffixClean(end))) end -= 1;
  if (end < first) return warn(`end<first (tail all shortTail/checkpoint)`);
  if (isCheckpoint(entries[end])) return warn(`end=${end} is checkpoint`);
  if (entries[end].est > CHUNK_MAX) return warn(`end=${end} est=${entries[end].est}>CHUNK_MAX`);

  const spanText = (spanStart: number, spanEnd: number) => {
    const bits: string[] = [];
    for (let index = spanStart; index <= spanEnd; index++) bits.push(entries[index].text);
    return bits.join("\n");
  };
  const liveText = (spanStart: number, spanEnd: number) => {
    const bits: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      if (index >= spanStart && index <= spanEnd) continue;
      bits.push(entries[index].text);
    }
    return bits.join("\n");
  };

  let start = end;
  let tokens = entries[end].est;
  let card = buildCard(spanText(start, end), liveText(start, end), cardBudgetFor(spanText(start, end)));
  if (card.verdict !== "TRUNK CONFIRMED") {
    return warn(`single-span UNCONFIRMED end=${end} role=${entries[end].role} est=${entries[end].est} hard=${card.hardCount} missing=${card.missing.length} omittedHard=${card.omittedHard} spanChars=${spanText(start, end).length}`);
  }
  while (start > first) {
    const prev = start - 1;
    if (isCheckpoint(entries[prev]) || isUser(entries[prev])) break;
    const nextTokens = tokens + entries[prev].est;
    if (nextTokens > CHUNK_MAX) break;
    const trial = buildCard(spanText(prev, end), liveText(prev, end), cardBudgetFor(spanText(prev, end)));
    if (trial.verdict !== "TRUNK CONFIRMED") break;
    tokens = nextTokens;
    start = prev;
    card = trial;
  }
  // 切割后 prefix 是 [0..start-1],所以平衡判据要取 start-1(原仓 toolPairingBalancedBefore)。
  // 取 prefixBalanced[start] 会把 start 自己的 result 算进来,放行「切走 result 但留下 call」
  // 的破坏性切割:此后 prefix 永久不平衡,整段会话再也不能切。
  while (start <= end && (isCheckpoint(entries[start]) || !cutOk(() => start <= 0 || prefixBalanced[start - 1]))) {
    tokens -= entries[start].est;
    start += 1;
  }
  if (start > end) return warn(`prefix-unbalanced pushed start past end (start=${start})`);
  if (tokens < CHUNK_MIN) return warn(`tokens=${tokens}<CHUNK_MIN`);
  if (isCheckpoint(entries[start])) return warn(`start=${start} is checkpoint`);
  card = buildCard(spanText(start, end), liveText(start, end), cardBudgetFor(spanText(start, end)));
  if (card.verdict !== "TRUNK CONFIRMED") return warn(`expanded-span UNCONFIRMED start=${start} end=${end}`);
  if (!cutOk(() => start <= 0 || prefixBalanced[start - 1])) return warn(`prefix not balanced at start=${start}`);
  if (!cutOk(() => suffixClean(end))) return warn(`suffix not clean at end=${end}`);
  let after = 0;
  for (let index = end + 1; index < entries.length; index++) after += entries[index].est;
  return { start, end, tokens, after, card, entries };
}

export default function (pi: ExtensionAPI) {
  // Idle cut: pi fires agent_before_settle once per run; outcome "completed"
  // mirrors DSH's turn/end reason.kind === "completed" gate.
  pi.on("agent_before_settle", (event: any, ctx: any) => {
    if (event.outcome !== "completed") return undefined;
    const state = stateFor(ctx);
    const entries = spineEntries(event.context?.contextEntries ?? []);
    if (entries.length === 0) return undefined;

    let totalTokens = ctx.getContextUsage?.()?.tokens ?? null;
    if (typeof totalTokens !== "number" || totalTokens === null) {
      totalTokens = entries.reduce((sum, entry) => sum + entry.est, 0);
    }
    // boundary handler 内拿不到「应用草稿后」的 usage(draft 要等 handler 返回才落地)。
    // 延后一轮也测不出切割收益:下一轮的 total 混着本轮新增内容(实测时曾出现 +4924 / +116316),
    // 无法把「切掉的量」从「新加的量」里分离。这里只量估算本身的偏差,
    // 用 ratio 判断 CJK 补正是否可信(接近 1.0 说明 est 与真实计价同量级)。
    const estSum = entries.reduce((sum, entry) => sum + entry.est, 0);
    if (totalTokens > 0 && estSum > 0) {
      logLine(state, `spine est bias: est=${estSum} actual=${totalTokens} ratio=${(estSum / totalTokens).toFixed(3)}`);
    }
    if (totalTokens < MIN_PRESSURE || totalTokens >= BIG_GATE) {
      logLine(state, `spine idle: total=${totalTokens} gate=${totalTokens < MIN_PRESSURE ? '<MIN' : '>BIG'} n=${entries.length} :: ${describeEntries(entries)}`);
      return undefined;
    }

    const chunk = selectNewestChunk(entries, (why) =>
      logLine(state, `spine skip: ${why} | total=${totalTokens} n=${entries.length} :: ${describeEntries(entries)}`));
    if (chunk === null) return undefined;
    if (chunk.entries.slice(chunk.start, chunk.end + 1).some((entry) => !entry.id)) {
      // 空 targetId 的 context_edit 会被 runner 忽略:条目没抹掉而卡片照加,净增长。
      logLine(state, "spine cut skipped: span contains an entry without id");
      return undefined;
    }
    if (chunk.after > MAX_TAIL && totalTokens < URGENT_TOKENS) return undefined;

    const before = totalTokens;
    const started = Date.now();
    let reduced = false;
    let framedTokens: number | undefined;
    let drafts: any[] = [];
    try {
      const spanEntries = entries.slice(chunk.start, chunk.end + 1);
      const shadow = shadowDirectory(state.key);
      mkdirSync(shadow, { recursive: true });
      const joined = spanEntries.map((entry) => entry.shadowText).join("\n\n");
      const file = join(shadow, shadowName(state.key, joined.length));

      const card = chunk.card;
      const summaryBlock = { type: "text", text: `${card.text}\nFull shadowed text: ${file}` };
      const content = [
        { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
        summaryBlock,
        { type: "text", text: SUMMARY_CLOSE_TAG },
      ];
      framedTokens = estimateTokens({ role: "user", content, timestamp: Date.now() });
      if (typeof framedTokens === "number" && framedTokens >= chunk.tokens) {
        // 先判定再落盘:被拒的切割不留孤儿 shadow 文件。
        throw new Error(`summary is not smaller than the shadowed content (${framedTokens} >= ${chunk.tokens})`);
      }
      writeFileSync(file, joined);
      pruneShadow(shadow);
      pruneShadowSessions(join(spineRoot(), "shadow"));

      drafts = [
        ...spanEntries.map((entry) => ({
          type: "context_edit" as const,
          targetId: entry.id,
          replacement: null,
        })),
        {
          type: "custom_message" as const,
          customType: SPINE_CUSTOM_TYPE,
          content,
          display: false,
          details: {
            shadowedRange: { start: spanEntries[0].id, end: spanEntries.at(-1).id },
            shadowedSeqs: spanEntries.map((entry) => entry.id),
            shadowedTokenCount: chunk.tokens,
            provider: "local",
            model: "spine-extract",
          },
        },
      ];

      const estimatedAfter = before - chunk.tokens + (typeof framedTokens === "number" ? framedTokens : 0);
      reduced = estimatedAfter < before;
      // est.: pi 扩展拿不到切割后的实测 token,这里只是 before - chunk + framed 的推算。
      logLine(state, `spine cut ${Date.now() - started}ms ${before} -> est.${estimatedAfter} chunk=${chunk.tokens} span=${chunk.start}..${chunk.end}/${entries.length}`);
      if (!reduced) {
        // 防御式阻断:正常流程 framed < chunk.tokens 保证恒 reduced,但护栏不能只写在日志里。
        logLine(state, `spine cut would not reduce ${before}; aborting`);
        return undefined;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLine(state, `spine cut failed: ${message}`);
      return undefined;
    }
    if (drafts.length === 0) return undefined;
    // 原仓 rememberPrefix 在 commitSelectedSpan 之后:前缀是「切割后」的形态,
    // 下一轮 sharedPrefixLength 才会接近全匹配(attach)。写成切割前的全文会让
    // 切割后首轮 ratio 掉到 0.9 以下,误判 send-less。
    state.lastPrefix = [
      ...entries.slice(0, chunk.start).filter((entry) => entry.role !== "system").map((entry) => entry.text),
      chunk.card.text,
      ...entries.slice(chunk.end + 1).map((entry) => entry.text),
    ].join("\n");
    state.lastPrefixTokens = Math.max(0, before - chunk.tokens + (framedTokens ?? 0));
    // Runner REPLACES the draft list with whatever a handler returns; preserve
    // drafts proposed by earlier handlers (e.g. Cindy's subagent extension).
    return { entries: [...(event.entries ?? []), ...drafts] };
  });

  // Thunder path: only when the stock threshold compaction fires.
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (process.env.SPINE_THUNDER !== "1") return undefined;
    const state = stateFor(ctx);
    const { preparation, customInstructions, signal } = event;
    const messages = [...(preparation?.messagesToSummarize ?? []), ...(preparation?.turnPrefixMessages ?? [])];
    if (!ctx.model) {
      logLine(state, "thunder skipped: no active model; leaving the gate to default compaction");
      return undefined;
    }
    let joined: string;
    try {
      // 必须与 state.lastPrefix 同构(原仓 summarize 里 joined === input.messages.map(messageText))。
      // 用 serializeConversation 会得到完全不同的格式,sharedPrefixLength 恒为 0 → 永远 send-less。
      joined = messages.map((message: any) => messageText(message)).join("\n");
    } catch (error) {
      logLine(state, `thunder serialize failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const mode = decideThunder({
      previous: state.lastPrefix || "",
      next: joined,
      modelKind: process.env.SPINE_THUNDER_MODEL === "27b" ? "27b" : "flash",
      prefixTokens: state.lastPrefixTokens || 0,
    });
    logLine(state, `thunder mode=${mode} prefixTokens=${state.lastPrefixTokens} spanChars=${joined.length}`);
    if (mode === "attach") return undefined;

    const users = messages.filter((message: any) => (message?.role ?? message?.message?.role) === "user");
    const taskLine = messageText(users.at(-1) || messages.at(-1)).slice(0, 500);
    const trunk = buildCard(joined, "");
    const facts = [...new Set([...(trunk.hardLines || []), ...(trunk.missing || [])])];
    const slim = buildSendLess({ taskLine, uncovered: trunk.uncovered, facts });
    const slimMessages = [{ role: "user", content: [{ type: "text", text: slim }], timestamp: Date.now() }];

    try {
      const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(ctx.model);
      if (!auth?.ok) {
        logLine(state, "thunder skipped: auth unavailable; leaving the gate to default compaction");
        return undefined;
      }
      const { text, usage } = await generateSummaryWithUsage(
        slimMessages,
        ctx.model,
        preparation?.settings?.reserveTokens,
        auth.apiKey,
        auth.headers,
        signal,
        customInstructions,
        preparation?.previousSummary,
        ctx.thinkingLevel,
      );
      logLine(state, `thunder send-less summary ok usage=${usage?.totalTokens ?? "?"}`);
      return {
        compaction: {
          summary: text,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage,
          details: { liveCompact: "thunder-send-less" },
        },
      };
    } catch (error) {
      logLine(state, `thunder send-less failed: ${error instanceof Error ? error.message : String(error)}`);
      // Fall back to pi's default compaction.
      return undefined;
    }
  });
}
