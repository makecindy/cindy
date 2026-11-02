/** Synthetic import candidates for the existing __DEV__ visual-mock provider; no real computer is read. */
const COLLECTION = 'session-import';
const PRIMITIVE = 'session-import';
const DAY = 86_400_000;
const NOW = 1793250000000;
const MB = 1024 * 1024;

type Row = [source: string, title: string, group: string, groupName: string, size: number, extra?: { missingDir?: boolean; unsupported?: boolean; harness?: string; mode?: string; outcome?: 'action' | 'failed' }];
const ROWS: Row[] = [
  ['codex', 'Fix imported Codex tasks that cannot continue', 'g-cindy', 'cindy', 227 * MB, { harness: 'codex', mode: 'native' }],
  ['claude', '设置页「任务导入」重构方案', 'g-cindy', 'cindy', 12 * MB, { harness: 'cc', mode: 'native' }],
  ['pi', 'review: Codex 分页历史祖先链补齐', 'g-cindy', 'cindy', 3 * MB, { harness: 'pi', mode: 'native' }],
  ['cursor', 'Landing page hero copy and pricing table', 'g-site', 'orbit-garden-site', 2 * MB, { harness: 'codex', mode: 'handoff' }],
  ['kimi', '清洗重复的计费事件', 'g-billing', 'billing-jobs', 5 * MB, { missingDir: true, harness: 'codex', mode: 'handoff', outcome: 'action' }],
  ['gemini', 'Add nightly export to S3', 'g-billing', 'billing-jobs', 1 * MB, { harness: 'codex', mode: 'handoff', outcome: 'failed' }],
  ['opencode', 'Migrate the settings store to SQLite', 'g-site', 'orbit-garden-site', 8 * MB, { harness: 'codex', mode: 'handoff' }],
  ['qwen', '整理本周产品周会纪要', 'dialogue', '', 1 * MB, { harness: 'codex', mode: 'handoff' }],
  ['deepseek', 'Old session written by a newer DeepSeek Harness', 'dialogue', '', 1 * MB, { unsupported: true }],
];

const candidates = ROWS.map(([source, title, group, groupName, sizeBytes, extra], i) => ({
  key: `${source}:mock-${i}`, source, title, group, groupName, dialogue: group === 'dialogue',
  updatedAt: NOW - i * DAY, archived: false, sizeBytes,
  missingDir: extra?.missingDir === true, unsupported: extra?.unsupported === true,
}));

interface Job { requestId: string; keys: string[]; polls: number; cancelled: boolean }
let job: Job | undefined;
let imported = new Set<string>();

function jobData(j: Job) {
  const items = j.keys.map((key, i) => {
    const c = candidates.find((x) => x.key === key)!;
    const extra = ROWS[candidates.indexOf(c)][5];
    const done = j.polls > i + 1;
    const status = j.cancelled && !done ? 'cancelled' : !done ? (j.polls === i + 1 ? 'running' : 'queued')
      : extra?.outcome ?? 'ready';
    return {
      key, source: c.source, title: c.title, status, step: status === 'running' ? 'messages' : null,
      messagesWritten: status === 'running' ? 133 : 0, mode: extra?.mode ?? null, harness: extra?.harness ?? null,
      issue: status === 'failed' ? 'read-failed' : null, sessionId: status === 'ready' ? `mock-import-${i}` : null,
    };
  });
  const running = items.some((it) => it.status === 'running' || it.status === 'queued');
  return { kind: 'job', requestId: j.requestId, status: running ? 'running' : 'done', items };
}

function resource(id: string, data: unknown) {
  return {
    ref: { collectionId: COLLECTION, kind: 'import', id }, revision: '1',
    display: { title: 'Import · Synthetic data' }, actions: [], links: [],
    blocks: [{ id: 'import', primitive: PRIMITIVE, fallbackMarkdown: '', data }],
  };
}

export function sessionImportVisualFixture(channel: string, raw: unknown): unknown {
  const request = raw as { ref?: { collectionId?: string; id?: string }; collectionId?: string; actionId?: string; input?: { keys?: string[] } };
  if (channel === 'maker:remote-resources:get' && request?.ref?.collectionId === COLLECTION) {
    const id = request.ref.id ?? '';
    if (id.startsWith('job:')) {
      if (!job) return resource(id, undefined);
      job.polls += 1;
      return resource(id, jobData(job));
    }
    const visible = candidates.filter((c) => !imported.has(c.key));
    return resource(id, { kind: 'scan', total: visible.length, candidates: visible, hiddenTotal: 214 + imported.size });
  }
  if (channel !== 'maker:remote-resources:invoke' || request?.collectionId !== COLLECTION) return undefined;
  if (request.actionId === 'import') {
    job = { requestId: `mock-${Date.now()}`, keys: request.input?.keys ?? [], polls: 0, cancelled: false };
    imported = new Set([...imported, ...job.keys]);
    return { result: jobData(job), effects: [] };
  }
  if (request.actionId === 'cancel' && job) job.cancelled = true;
  return { result: job ? jobData(job) : undefined, effects: [] };
}
