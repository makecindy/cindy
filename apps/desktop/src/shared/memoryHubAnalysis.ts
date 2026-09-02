/**
 * memoryHubAnalysis — Memory Hub 分析结果的共享类型 (main 产出 / renderer 消费)。
 * AI 洞察是派生视图: 只给用户看, 永不注入 prompt / system 段。
 */

export type MemoryHubRecommendationKind = 'update' | 'merge' | 'deprecate' | 'review';

export interface MemoryHubRecommendation {
  id: string;
  kind: 'stale' | 'overlap' | 'deprecated' | 'misplaced' | 'gap' | MemoryHubRecommendationKind;
  severity: 'info' | 'warning' | 'critical';
  filename: string;
  relatedFilename?: string;
  title: string;
  reason: string;
  suggestedAction: MemoryHubRecommendationKind;
  createdAt: string;
}

export interface MemoryHubAiAnalysis {
  text: string;
  generatedAt: string;
  source: 'manual' | 'background';
  recommendations: MemoryHubRecommendation[];
}

export interface MemoryHubInsightsResult {
  totalEntries: number;
  byType: Record<string, number>;
  staleCount: number;
  lastActivityAt: string | null;
  recentEvents: Array<{
    id: number;
    ts: string;
    op: string;
    actor: string;
    filename: string;
    type: string;
    title: string;
    description: string;
  }>;
  gapHints: string[];
  recommendations: MemoryHubRecommendation[];
}
