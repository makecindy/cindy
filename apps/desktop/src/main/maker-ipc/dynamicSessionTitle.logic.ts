/**
 * 动态任务标题的纯逻辑:模型输出解析、最终标题拼装、系统标题识别、冷却判定。
 *
 * 无 DB / electron / 网络依赖,单测直接覆盖(工程规范 §3)。编排与副作用见
 * dynamicSessionTitle.ts。
 */

import { normalizeAutoTitle } from '@cindy/maker-shared/session-title';

export const DYNAMIC_TITLE_TYPE_LABELS = [
  '功能',
  '设计',
  '修复',
  '优化',
  '发布',
  '探索',
  '文档',
  '研究',
] as const;

export type DynamicTitleTypeLabel = (typeof DYNAMIC_TITLE_TYPE_LABELS)[number];

/**
 * 模型输出的 TYPE 容错归一:英文码或中文标签都接受,落库统一为中文标签 ——
 * 标题全局中文(产品口径),也让重启后的格式识别(isDynamicTitlePattern)
 * 有唯一形状可匹配。
 */
const TYPE_ALIASES: Record<string, DynamicTitleTypeLabel> = {
  功能: '功能',
  设计: '设计',
  修复: '修复',
  优化: '优化',
  发布: '发布',
  探索: '探索',
  文档: '文档',
  研究: '研究',
  FEA: '功能',
  DES: '设计',
  FIX: '修复',
  OPT: '优化',
  REL: '发布',
  EXP: '探索',
  DOC: '文档',
  RES: '研究',
};

/** Topic 的 code point 上限(MMDD｜TYPE｜ 前缀之外),防止标题吃满 40 字上限。 */
export const DYNAMIC_TITLE_TOPIC_MAX_CHARS = 24;

const TITLE_SEPARATOR = '｜';
const SEPARATOR_RUN_RE = /[｜|]+/gu;
const TRAILING_PUNCT_RE = /[。．.!！?？;；,，、~～]+$/u;

/**
 * 本模式写出的标题形状(重启后识别「系统生成、可继续更新」的唯一依据)。
 * 刻意只认全角分隔符与英文码 —— 这是本模块唯一的落库形状。
 */
const DYNAMIC_TITLE_PATTERN = /^\d{4}｜(?:功能|设计|修复|优化|发布|探索|文档|研究)｜/u;

/** createdAt(epoch ms)→ Asia/Shanghai 的 MMDD。日期只由本侧计算,不信任模型。 */
export function formatShanghaiMonthDay(createdAtMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(createdAtMs));
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return month + day;
}

function capCodePoints(value: string, max: number): string {
  let out = '';
  let count = 0;
  for (const char of value) {
    if (count >= max) break;
    out += char;
    count += 1;
  }
  return out;
}

export interface ParsedDynamicTitle {
  typeLabel: DynamicTitleTypeLabel;
  topic: string;
}

/**
 * 解析模型返回的 类型｜主题。解析失败(段数不对 / TYPE 不在词表 / 主题为空)
 * 返回 null,调用方保留原标题 —— 产品规格:认不出主题就不改,不猜。
 */
export function parseDynamicTitleModelOutput(
  raw: string | null | undefined,
): ParsedDynamicTitle | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const segments = cleaned.split(/[｜|]/u).map((segment) => segment.trim());
  if (segments.length !== 2) return null;
  const rawType = segments[0] ?? '';
  const typeLabel = TYPE_ALIASES[rawType] ?? TYPE_ALIASES[rawType.toUpperCase()];
  if (!typeLabel) return null;
  const topic = capCodePoints(
    (segments[1] ?? '')
      .replace(SEPARATOR_RUN_RE, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(TRAILING_PUNCT_RE, ''),
    DYNAMIC_TITLE_TOPIC_MAX_CHARS,
  ).trim();
  if (!topic) return null;
  return { typeLabel, topic };
}

/** 拼最终标题 MMDD｜类型｜主题(走统一的 40 字归一化出口)。 */
export function buildDynamicSessionTitle(args: {
  createdAtMs: number;
  typeLabel: DynamicTitleTypeLabel;
  topic: string;
}): string {
  const topic = args.topic.replace(SEPARATOR_RUN_RE, ' ').replace(/\s+/gu, ' ').trim();
  return normalizeAutoTitle(
    formatShanghaiMonthDay(args.createdAtMs) + TITLE_SEPARATOR + args.typeLabel + TITLE_SEPARATOR + topic,
  );
}

export function isDynamicTitlePattern(title: string): boolean {
  return DYNAMIC_TITLE_PATTERN.test(title);
}

/** per-session 冷却判定:两次刷新间隔不得小于 minIntervalMs。 */
export function shouldAttemptDynamicTitle(args: {
  nowMs: number;
  lastAttemptMs: number | null;
  minIntervalMs: number;
}): boolean {
  return args.lastAttemptMs === null || args.nowMs - args.lastAttemptMs >= args.minIntervalMs;
}
