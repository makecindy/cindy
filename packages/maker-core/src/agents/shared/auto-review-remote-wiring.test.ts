import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const agentsRoot = resolve(__dirname, '..');
const readAgent = (name: string): string =>
  readFileSync(resolve(agentsRoot, name, 'index.ts'), 'utf8').replace(/\r\n?/g, '\n');

describe('remote shell realpath evidence wiring', () => {
  it.each(['pi', 'claude-code', 'codex'])('%s marks remote exec path resolution unavailable', (agent) => {
    const source = readAgent(agent);
    expect(source).toMatch(/destructivePathResolution\s*(?::|=)\s*'unavailable'/);
  });
});
