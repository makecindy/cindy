import { forbid, mountPage, subscription } from '../../ui-page/harness';
import { SessionImportSection } from '../../../src/renderer/components/settings/SessionImportSection';
import type { ImportCandidate, ImportJobView, ImportScanResult, ImportSourceId } from '../../../src/shared/sessionImport';

const NOW = 1793250000000;
const DAY = 86_400_000;
const MB = 1024 * 1024;

function candidate(source: ImportSourceId, index: number, title: string, group: string | null, extra: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    key: `${source}:fixture-${index}`, source, id: `fixture-${index}`, title,
    cwd: group ? `/Users/alex/Projects/${group}` : null,
    groupKey: group ? `/Users/alex/Projects/${group}` : 'dialogue', groupName: group ?? '',
    groupPath: group ? `~/Projects/${group}` : null, dialogue: !group,
    updatedAt: NOW - index * DAY, archived: false, sizeBytes: 4 * MB, missingDir: false, hidden: null,
    unsupportedVersion: null, ...extra,
  };
}

const CANDIDATES: ImportCandidate[] = [
  candidate('codex', 0, 'Fix imported Codex tasks that cannot continue', 'cindy', { sizeBytes: 227 * MB }),
  candidate('claude', 1, '设置页「任务导入」重构方案', 'cindy'),
  candidate('pi', 2, 'review: Codex 分页历史祖先链补齐', 'cindy'),
  candidate('cursor', 3, 'Landing page hero copy and pricing table', 'orbit-garden-site'),
  candidate('opencode', 4, 'Migrate the settings store to SQLite', 'orbit-garden-site', { archived: true }),
  candidate('kimi', 5, '清洗重复的计费事件', 'billing-jobs', { missingDir: true }),
  candidate('gemini', 6, 'Add nightly export to S3', 'billing-jobs', { missingDir: true }),
  candidate('qwen', 7, '整理本周产品周会纪要', null),
  candidate('deepseek', 8, 'Old session written by a newer DeepSeek Harness', null, { unsupportedVersion: '5' }),
];

const SCAN: ImportScanResult = {
  candidates: CANDIDATES,
  hiddenCounts: { cindy: 220, temp: 12, internal: 41, imported: 3 },
  sources: (['claude', 'codex', 'pi', 'opencode', 'gemini', 'cursor', 'qwen', 'kimi', 'deepseek'] as ImportSourceId[])
    .map((id) => ({ id, label: id, count: CANDIDATES.filter((c) => c.source === id).length })),
  sourceErrors: [{ id: 'factory', message: 'permission denied' }],
  scannedAt: NOW,
};

const RESULT: ImportJobView = {
  requestId: 'fixture-job', status: 'done', startedAt: NOW, finishedAt: NOW + 4000,
  items: [
    { key: 'codex:fixture-0', source: 'codex', title: CANDIDATES[0]!.title, status: 'ready', step: null, messagesWritten: 812, mode: 'native', harness: 'codex', issue: null, sessionId: 'imp-codex-0' },
    { key: 'cursor:fixture-3', source: 'cursor', title: CANDIDATES[3]!.title, status: 'ready', step: null, messagesWritten: 33, mode: 'handoff', harness: 'codex', issue: null, sessionId: 'imp-cursor-3' },
    { key: 'kimi:fixture-5', source: 'kimi', title: CANDIDATES[5]!.title, status: 'action', step: null, messagesWritten: 64, mode: 'handoff', harness: 'codex', issue: 'missing-dir', sessionId: 'imp-kimi-5' },
    { key: 'gemini:fixture-6', source: 'gemini', title: CANDIDATES[6]!.title, status: 'failed', step: null, messagesWritten: 0, mode: null, harness: null, issue: 'read-failed', sessionId: null },
  ],
};

const RUNNING: ImportJobView = {
  ...RESULT, status: 'running', finishedAt: null,
  items: RESULT.items.map((item, i) => i === 0 ? item
    : i === 1 ? { ...item, status: 'running', step: 'messages', messagesWritten: 133, sessionId: null }
      : { ...item, status: 'queued', messagesWritten: 0, sessionId: null }),
};

(window as unknown as { __importResult: ImportJobView }).__importResult = RESULT;

mountPage({
  route: '/settings?tab=import',
  host: (ctx) => ({
    platform: 'darwin',
    localDb: { sessionImport: {
      scan: async () => (ctx.case === 'empty' ? { ...SCAN, candidates: [], sources: [], sourceErrors: [] } : SCAN),
      status: async () => (ctx.case === 'result' || ctx.case === 'running' ? RUNNING : null),
      onProgress: subscription('progress'),
      start: forbid('localDb.sessionImport.start'),
      cancel: forbid('localDb.sessionImport.cancel'),
      relocate: forbid('localDb.sessionImport.relocate'),
    } },
    showOpenDirectoryDialog: forbid('showOpenDirectoryDialog'),
  }),
  render: () => <div className="h-screen p-6"><SessionImportSection /></div>,
});
