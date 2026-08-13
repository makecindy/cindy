import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..');
const attentionIconSource = readFileSync(
  resolve(
    repoRoot,
    'src/renderer/features/right-sidebar/plugins/orca-workers/OrcaWorkersAttentionIcon.tsx',
  ),
  'utf8',
);
const tabBodySource = readFileSync(
  resolve(
    repoRoot,
    'src/renderer/features/right-sidebar/plugins/orca-workers/OrcaWorkersTabBody.tsx',
  ),
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
    expect(attentionIconSource).toContain("useWorkerProjection(sessionId ?? '')");
    expect(attentionIconSource).not.toContain('useWorkers(');
    expect(attentionIconSource).not.toContain('revalidate');
  });

  it('keeps right-sidebar tab bodies owning projections across active and detached lifetimes', () => {
    expect(tabBodySource).toContain('useWorkerProjectionOwner(ctx.sessionId);');
    expect(tabBodySource).toContain('revalidateActiveWorkersProjection(ctx.sessionId)');
    expect(tabBodySource).toContain('revalidateActiveWorkerSettings(ctx.sessionId)');
    expect(tabBodySource).toContain('if (!active || !shellVisible || !windowVisible) return;');
  });

  it('runs the attention projection inside the detached sidebar renderer', () => {
    expect(tabBodySource).toContain('isSidebarWindow() ? [ctx.sessionId] : []');
    expect(tabBodySource).toContain('useOrcaWorkerAttentionByLeadIds(');
    expect(tabBodySource).toContain('viewVisible ? ctx.sessionId : undefined');
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
