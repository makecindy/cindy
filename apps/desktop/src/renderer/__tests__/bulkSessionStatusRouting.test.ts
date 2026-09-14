import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

function handlerSource(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('bulk session status routing', () => {
  it('multi-select delete freezes the resolved target and treats a local collision as local', () => {
    const handler = handlerSource(
      'const handleBulkDelete = useCallback',
      'const handleBulkArchive = useCallback',
    );

    expect(handler).toContain('sessionService.resolveStatusWriteTarget(session.id)');
    expect(handler).toContain(
      "sessionService.setStatus(session.id, 'deleted', statusWriteTarget)",
    );
    expect(handler).toContain("statusWriteTarget.kind === 'local'");
    expect(handler).not.toContain('sessionService.patchMeta(');
  });

  it('multi-select archive freezes the resolved target and converges a local collision locally', () => {
    const handler = handlerSource(
      'const handleBulkArchive = useCallback',
      'const handleArchiveAllInProject = useCallback',
    );

    expect(handler).toContain('sessionService.resolveStatusWriteTarget(session.id)');
    expect(handler).toContain(
      "sessionService.setStatus(session.id, 'archived', statusWriteTarget)",
    );
    expect(handler).toContain("statusWriteTarget.kind === 'local'");
    expect(handler).toContain(
      "patchLocal(session.id, { status: 'archived', pinnedAt: null })",
    );
    expect(handler).not.toContain('sessionService.patchMeta(');
  });
});
