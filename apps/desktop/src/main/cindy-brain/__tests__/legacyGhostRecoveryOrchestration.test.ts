import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('legacy Ghost recovery acknowledgement orchestration', () => {
  it('keeps both retry-pending and deterministic backfill failures in the durable marker', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    const start = source.indexOf(
      'const backfill = await getGhostManager().backfillRecoveredLegacyGhosts(',
    );
    const end = source.indexOf("log.warn('recovered legacy ghost backfill pass failed'", start);
    const acknowledgementBlock = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(acknowledgementBlock).toContain('const pending = new Set(backfill.pending ?? []);');
    expect(acknowledgementBlock).toContain('const failed = new Set(backfill.failed);');
    expect(acknowledgementBlock).toContain(
      'recoveredLegacyIds.filter((id) => !pending.has(id) && !failed.has(id))',
    );
  });
});
