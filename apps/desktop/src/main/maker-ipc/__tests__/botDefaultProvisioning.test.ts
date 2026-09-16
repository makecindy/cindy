import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markDefaultBotOffered, provisionDefaultBot } from '../botDefaultProvisioning.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-initial-bot-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('default companion provisioning', () => {
  it('creates once across repeated entry and deletion of every Bot', async () => {
    const create = vi.fn(async () => undefined);
    const input = { ownerRoot: root, assertOwner: () => {}, hasBotHistory: async () => false, create };
    await Promise.all([provisionDefaultBot(input), provisionDefaultBot(input)]);
    await provisionDefaultBot(input);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('preserves an existing roster and its later deletion', async () => {
    const create = vi.fn();
    const input = { ownerRoot: root, assertOwner: () => {}, hasBotHistory: async () => true, create };
    await provisionDefaultBot(input);
    await provisionDefaultBot({ ...input, hasBotHistory: async () => false });
    expect(create).not.toHaveBeenCalled();
  });
  it('records deletion before initialization so a removed Cindy cannot return', async () => {
    const create = vi.fn();
    await markDefaultBotOffered(root);
    await provisionDefaultBot({ ownerRoot: root, assertOwner: () => {}, hasBotHistory: async () => false, create });
    expect(create).not.toHaveBeenCalled();
  });
  it('retries a failed creation without claiming it was provisioned', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const input = { ownerRoot: root, assertOwner: () => {}, hasBotHistory: async () => false, create };
    await expect(provisionDefaultBot(input)).rejects.toThrow('offline');
    await provisionDefaultBot(input);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
