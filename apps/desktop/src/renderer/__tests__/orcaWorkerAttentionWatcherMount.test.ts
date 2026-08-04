import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const watcherSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'hooks', 'useOrcaWorkerAttentionWatcher.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

const projectionSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'hooks', 'workerProjectionStore.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

const orcaSplitViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'OrcaSplitView.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('Orca worker attention watcher mount', () => {
  it('mounts the worker attention watcher in CCAgentSidebarUpper root, not inside ExpandedView', () => {
    const rootBlock = extractBetween(
      sidebarSource,
      'export function CCAgentSidebarUpper()',
      'function ExpandedView(',
    );
    const expandedBlock = sidebarSource.slice(sidebarSource.indexOf('function ExpandedView('));

    expect(rootBlock).toContain('useOrcaWorkerAttentionWatcher(sessionsHook.sessions, activeSessionId);');
    expect(expandedBlock).not.toContain('useOrcaWorkerAttentionWatcher(');
  });

  it('derives attention from the projection store, whose request sequence rejects stale results', () => {
    expect(watcherSource).toContain('useWorkerProjectionVersion()');
    expect(watcherSource).toContain('getWorkerProjectionSnapshot(leadSessionId)');
    expect(watcherSource).not.toContain('listWorkersByLead(');
    expect(projectionSource).toContain('if (item.entry.requestSeq !== item.requestId)');
    expect(projectionSource).toContain('if (entry.requestSeq !== requestId)');
  });

  it('clears only visible non-done worker attention before paint in doc-mode toggle layout', () => {
    const splitViewBlock = extractBetween(
      orcaSplitViewSource,
      'export function OrcaSplitView({',
      'const activePane = togglePane;',
    );

    expect(splitViewBlock).toContain('const attention = useWorkerAttentionSnapshot();');
    expect(splitViewBlock).toContain('useLayoutEffect(() => {');
    expect(splitViewBlock).toContain("togglePane === 'worker' &&");
    expect(splitViewBlock).toContain('reportAgentIslandVisibility &&');
    expect(splitViewBlock).toContain("selectedWorkerRecord?.status !== 'done'");
    expect(splitViewBlock).toContain('clearWorkerAttention(selectedWorkerId);');
  });
});

function extractBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
