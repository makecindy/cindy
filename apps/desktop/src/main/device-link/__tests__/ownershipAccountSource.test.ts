import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('device-link ownership account source wiring', () => {
  it('keeps using the lifecycle DbClient owner after worker takeover closes main localDb', () => {
    const source = readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');
    const resolverStart = source.indexOf('function getOwnershipLock()');
    const resolverEnd = source.indexOf('\n/**', resolverStart);
    const resolver = source.slice(resolverStart, resolverEnd);

    expect(resolverStart).toBeGreaterThanOrEqual(0);
    expect(resolverEnd).toBeGreaterThan(resolverStart);
    expect(source).toContain(
      "import { getCurrentDbClientUserId } from '../localDb/client/current';",
    );
    expect(resolver).toContain('getCurrentDbClientUserId()');
    expect(resolver).not.toContain('const userId = getCurrentUserId();');
  });
});
