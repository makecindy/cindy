/**
 * memory-hub-ai-analysis — Memory Hub 洞察 tab 的 AI 一次性分析。
 *
 * 设计要点 (memory-hub-plan.md §4/§5):
 *  - 模型走系统默认 one-shot 路由 (requestUtilityText), 不硬编码模型。
 *  - 输入只给索引 + 条目摘要 (title/description/type/updatedAt) + 最近事件,
 *    不发全量正文, 控制成本。
 *  - 产出是纯派生视图: 只给用户看, 永不注入 prompt / system 段。
 *  - AI 只建议不执行; 推荐的任何写动作都必须经用户逐条确认。
 */

import type { Maker, MakerMemoryStore, MemoryEvent, MemoryRecord } from '@cindy/maker-core';

import type { MemoryHubRecommendation } from '../../shared/memoryHubAnalysis.js';
import { requestUtilityText } from '../utility-model/oneShotCandidates.js';

export interface MemoryHubAiAnalysisResult {
  text: string;
  generatedAt: string;
  source: 'manual' | 'background';
  recommendations: MemoryHubRecommendation[];
}

const MAX_INPUT_ENTRIES = 120;
const MAX_RECENT_EVENTS = 40;
const MAX_TEXT_CHARS = 6000;

export function buildMemoryHubAiPrompt(
  entries: readonly MemoryRecord[],
  recentEvents: readonly MemoryEvent[],
): string {
  const entrySummaries = entries
    .slice(0, MAX_INPUT_ENTRIES)
    .map((entry) => {
      const age = Math.floor((Date.now() - new Date(entry.frontmatter.updatedAt).getTime()) / 86_400_000);
      return '- [' + entry.frontmatter.type + '] ' + entry.frontmatter.title + ' | ' + entry.frontmatter.description + ' | ' + age + 'd ago';
    })
    .join('\n');
  const eventLines = recentEvents
    .slice(0, MAX_RECENT_EVENTS)
    .map((event) => '- ' + event.ts + ' ' + event.op + ' ' + event.type + ' "' + event.title + '" (' + event.actor + ')')
    .join('\n');
  return [
    "You are analyzing a user's long-term agent memory store. Respond ONLY with JSON (no markdown fences).",
    'Schema:',
    '{"text": "string - a concise profile summary of the user in the same language as the memory entries, covering work focus, preferences and collaboration habits; reference entry titles inline",',
    ' "gaps": ["string - directions worth remembering that have no memory coverage yet"],',
    ' "recommendations": [{"kind": "update"|"merge"|"deprecate"|"review", "filename": "string", "relatedFilename": "string (merge only)", "title": "string", "reason": "string", "suggestedAction": "update"|"merge"|"deprecate"|"review"}]}',
    '',
    'Memory entries:',
    entrySummaries || '(empty)',
    '',
    'Recent changes:',
    eventLines || '(none)',
  ].join('\n');
}

function extractJson(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('model response is not JSON');
  }
}

const RECOMMENDATION_KINDS = ['update', 'merge', 'deprecate', 'review'] as const;

function isRecommendationKind(value: unknown): value is (typeof RECOMMENDATION_KINDS)[number] {
  return typeof value === 'string' && (RECOMMENDATION_KINDS as readonly string[]).includes(value);
}

export function parseMemoryHubAiResponse(raw: string, now: string): MemoryHubAiAnalysisResult {
  const parsed = extractJson(raw) as {
    text?: unknown;
    gaps?: unknown;
    recommendations?: unknown;
  };
  if (typeof parsed.text !== 'string' || parsed.text.trim() === '') {
    throw new Error('model response missing text');
  }
  const gaps = Array.isArray(parsed.gaps)
    ? parsed.gaps.filter((gap): gap is string => typeof gap === 'string').slice(0, 6)
    : [];
  const recommendations: MemoryHubRecommendation[] = Array.isArray(parsed.recommendations)
    ? parsed.recommendations
        .filter((rec): rec is Record<string, unknown> => !!rec && typeof rec === 'object')
        .flatMap((rec) => {
          const kind = isRecommendationKind(rec.kind) ? rec.kind : null;
          const filename = typeof rec.filename === 'string' ? rec.filename : null;
          if (!kind || !filename) return [];
          const suggestedAction = isRecommendationKind(rec.suggestedAction) ? rec.suggestedAction : kind;
          return [{
            id: 'ai-' + filename + '-' + kind,
            kind,
            severity: kind === 'deprecate' ? 'warning' : 'info',
            filename,
            relatedFilename: typeof rec.relatedFilename === 'string' ? rec.relatedFilename : undefined,
            title: typeof rec.title === 'string' ? rec.title : filename,
            reason: typeof rec.reason === 'string' ? rec.reason : '',
            suggestedAction,
            createdAt: now,
          } satisfies MemoryHubRecommendation];
        })
        .slice(0, 20)
    : [];
  const gapSection = gaps.length > 0 ? '\n\n' + ['Gaps:', ...gaps.map((gap) => '- ' + gap)].join('\n') : '';
  const text = parsed.text.slice(0, MAX_TEXT_CHARS) + gapSection;
  return { text, generatedAt: now, source: 'manual', recommendations };
}

/**
 * 对单个 scope 跑一次 AI 分析 (manual 按钮与后台调度共用同一路径)。
 * 失败返回 null — 洞察是 best-effort 派生视图, 不阻塞任何主流程。
 */
export async function runMemoryHubAiAnalysisForStore(opts: {
  maker: Maker;
  store: MakerMemoryStore;
  source: 'manual' | 'background';
  log: { warn(message: string, meta?: Record<string, unknown>): void };
}): Promise<MemoryHubAiAnalysisResult | null> {
  const entries = await opts.store.list();
  const events = await opts.store.recentEvents(MAX_RECENT_EVENTS);
  const prompt = buildMemoryHubAiPrompt(entries, events);
  const result = await requestUtilityText(opts.maker, prompt, {
    maxTokens: 1600,
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    opts.log.warn('memory hub ai analysis failed', { reason: result.reason, source: opts.source });
    return null;
  }
  try {
    const parsed = parseMemoryHubAiResponse(result.text, new Date().toISOString());
    return { ...parsed, source: opts.source };
  } catch (err) {
    opts.log.warn('memory hub ai analysis parse failed', {
      source: opts.source,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
