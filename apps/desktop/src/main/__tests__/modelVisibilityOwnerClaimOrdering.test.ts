import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');

describe('model visibility owner claim IPC ordering', () => {
  it('registers the synchronous claim handler before the first BrowserWindow is created', () => {
    const registration = source.indexOf('registerModelVisibilityOwnerClaimIpc();');
    const createWindow = source.indexOf('startupWindowCreationAllowed = true;');

    expect(registration).toBeGreaterThanOrEqual(0);
    expect(createWindow).toBeGreaterThan(registration);
  });
});
