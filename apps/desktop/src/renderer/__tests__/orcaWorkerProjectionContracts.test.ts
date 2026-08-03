import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..');
const pluginSource = readFileSync(
  resolve(repoRoot, 'src/renderer/features/right-sidebar/plugins/orca-workers/index.tsx'),
  'utf8',
);
const selectionSource = readFileSync(
  resolve(repoRoot, 'src/renderer/features/cc-agent/hooks/useOrcaWorkerSelection.ts'),
  'utf8',
);
const sessionViewSource = readFileSync(
  resolve(repoRoot, 'src/renderer/features/cc-agent/CCAgentSessionView.tsx'),
  'utf8',
);
const sessionHeaderSource = readFileSync(
  resolve(repoRoot, 'src/renderer/features/cc-agent/SessionContentHeader.tsx'),
  'utf8',
);

describe('Orca worker projection integration contracts', () => {
  it('keeps inactive right-sidebar pills on the read-only projection path', () => {
    const attentionDotBlock = extractBetween(
      pluginSource,
      'function OrcaWorkersAttentionDot',
      'function OrcaWorkersTabBody',
    );

    expect(attentionDotBlock).toContain('useWorkerProjection(sessionId)');
    expect(attentionDotBlock).not.toContain('useWorkers(');
    expect(attentionDotBlock).not.toContain('revalidate');
  });

  it('keeps right-sidebar tab bodies owning projections across active and detached lifetimes', () => {
    const tabBodyBlock = extractBetween(
      pluginSource,
      'function OrcaWorkersTabBody',
      'const plugin: TabKindPlugin',
    );

    expect(tabBodyBlock).toContain('useWorkerProjectionOwner(ctx.sessionId);');
    expect(tabBodyBlock).toContain('revalidateActiveWorkersProjection(ctx.sessionId)');
    expect(tabBodyBlock).toContain('revalidateActiveWorkerSettings(ctx.sessionId)');
    expect(tabBodyBlock).toContain('if (!active || !shellVisible || !windowVisible) return;');
  });

  it('runs the attention projection inside the detached sidebar renderer', () => {
    const tabBodyBlock = extractBetween(
      pluginSource,
      'function OrcaWorkersTabBody',
      'const plugin: TabKindPlugin',
    );

    expect(tabBodyBlock).toContain('isSidebarWindow() ? [ctx.sessionId] : []');
    expect(tabBodyBlock).toContain('useOrcaWorkerAttentionByLeadIds(');
    expect(tabBodyBlock).toContain('viewVisible ? ctx.sessionId : undefined');
  });

  it('keeps doc rail worker selection on useWorkers so it still receives live projection updates', () => {
    expect(selectionSource).toContain("import { useWorkers } from './useWorkers';");
    expect(selectionSource).toContain('} = useWorkers(leadSessionId);');
  });

  it('keeps renderer worker reads behind the shared projection store', () => {
    expect(sessionViewSource).toContain('useWorkerProjection(collabProjectionLeadId)');
    expect(sessionViewSource).not.toContain('.listWorkersByLead(collabSessionId)');
    expect(sessionHeaderSource).toContain('revalidateWorkersProjection(session.id)');
    expect(sessionHeaderSource).not.toContain('.listWorkersByLead(session.id)');
  });
});

function extractBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`missing source block ${start}..${end}`);
  }
  return source.slice(startIndex, endIndex);
}
