/** 本地转录索引的刷新状态；旧快照可用性与本次扫描是否完整独立表达。 */
export interface SkillUsageRefreshStatus {
  phase: 'idle' | 'discovering' | 'indexing' | 'complete' | 'incomplete';
  scanned: number;
  total: number;
  lastSuccessAt: number | null;
  hasSnapshot: boolean;
  incomplete: boolean;
  missingCount: number;
  error: string | null;
}
