import { describe, expect, it, vi } from 'vitest';
import { createMcpServerNamesReader } from '../mcpServerNames.js';

describe('createMcpServerNamesReader', () => {
  it('reads the server list once for every companion of a cycle, again after it, and again for another owner', async () => {
    const list = vi.fn(async () => [{ id: 'mcp-1', name: 'Docs' }]);
    let owner = 'a'; let clock = 0;
    const read = createMcpServerNamesReader(list, () => owner, { ttlMs: 1000, now: () => clock });
    expect(await Promise.all([read(), read(), read()])).toEqual(Array(3).fill({ 'mcp-1': 'Docs' }));
    expect(list).toHaveBeenCalledTimes(1);
    clock = 1001; await read();
    expect(list).toHaveBeenCalledTimes(2);
    owner = 'b'; await read();
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('gives no names for a list that cannot be read', async () => {
    const read = createMcpServerNamesReader(async () => { throw new Error('db'); }, () => 'a');
    expect(await read()).toEqual({});
  });
});
