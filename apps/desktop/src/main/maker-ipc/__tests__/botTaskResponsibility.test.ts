import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { botProfileDir } from '../botProfileFolder.js';
import { collectTaskResponsibilityScopes, readTaskResponsibilities, responsibleSessionIds, setTaskResponsibility } from '../botTaskResponsibility.js';

// Lock mechanics have their own cross-process suite; exercise this store's guarded write.
vi.mock('../../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (_file: string, _options: unknown, run: (lock: { held: true }) => unknown) => run({ held: true }),
}));
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-task-responsibility-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('task responsibility', () => {
  it('uses only verified creation and explicit records; releases override creation across reads', async () => {
    expect(await readTaskResponsibilities(root, 'one')).toEqual({});
    await setTaskResponsibility(root, 'one', 'taken', true, () => {});
    await setTaskResponsibility(root, 'one', 'created', false, () => {});
    expect(responsibleSessionIds(['created', 'across-project'], await readTaskResponsibilities(root, 'one')))
      .toEqual(['across-project', 'taken']);
    await setTaskResponsibility(root, 'one', 'taken', false, () => {});
    expect(responsibleSessionIds(['created'], await readTaskResponsibilities(root, 'one'))).toEqual([]);
    expect(await readTaskResponsibilities(root, 'two')).toEqual({});
    expect(await readTaskResponsibilities(root + '-other-owner', 'one')).toEqual({});
  });
  it('does not touch workbench judgments or Todo when taking or releasing', async () => {
    const home = botProfileDir(root, 'one');
    await fs.mkdir(home, { recursive: true });
    for (const name of ['workbench.json', 'todos.v1.json']) await fs.writeFile(path.join(home, name), 'original');
    await setTaskResponsibility(root, 'one', 'taken', true, () => {});
    await setTaskResponsibility(root, 'one', 'taken', false, () => {});
    for (const name of ['workbench.json', 'todos.v1.json']) expect(await fs.readFile(path.join(home, name), 'utf8')).toBe('original');
  });
  it('fails closed on corruption and preserves the damaged file', async () => {
    const home = botProfileDir(root, 'one');
    await fs.mkdir(home, { recursive: true });
    const file = path.join(home, 'task-responsibility.v1.json');
    await fs.writeFile(file, '{broken');
    await expect(readTaskResponsibilities(root, 'one')).rejects.toThrow();
    await expect(setTaskResponsibility(root, 'one', 'new', true, () => {})).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });
  it('rejects an owner change before commit and leaves no temporary file', async () => {
    let checks = 0;
    await expect(setTaskResponsibility(root, 'one', 'new', true, () => {
      if (++checks === 3) throw new Error('OWNER_SCOPE_CHANGED');
    })).rejects.toThrow('OWNER_SCOPE_CHANGED');
    expect(await readTaskResponsibilities(root, 'one')).toEqual({});
    expect(await fs.readdir(botProfileDir(root, 'one'))).toEqual([]);
  });
});

it('keeps healthy companions visible while failing closed for a damaged release store', async () => {
  await setTaskResponsibility(root, 'healthy', 'owned', true, () => {});
  await setTaskResponsibility(root, 'damaged', 'created', false, () => {});
  const file = path.join(botProfileDir(root, 'damaged'), 'task-responsibility.v1.json');
  await fs.writeFile(file, '{broken');
  const scopes = await collectTaskResponsibilityScopes(['damaged', 'healthy'], async (botId) => ({
    sessionIds: responsibleSessionIds(botId === 'damaged' ? ['created'] : [], await readTaskResponsibilities(root, botId)),
    delegatedSessionIds: botId === 'damaged' ? ['created'] : [],
  }));
  // A taken-over task is a responsibility, not one of the Bot's own background tasks.
  expect(scopes).toEqual([{ botId: 'healthy', directories: [], sessionIds: ['owned'], delegatedSessionIds: [] }]);
  expect(await fs.readFile(file, 'utf8')).toBe('{broken');
});

it('keeps a Bot that released its only background task as that task\'s origin', async () => {
  await setTaskResponsibility(root, 'origin', 'child', false, () => {});
  const scopes = await collectTaskResponsibilityScopes(['origin', 'idle'], async (botId) => ({
    sessionIds: responsibleSessionIds(botId === 'origin' ? ['child'] : [], await readTaskResponsibilities(root, botId)),
    delegatedSessionIds: botId === 'origin' ? ['child'] : [],
  }));
  // Nothing followed any more, but the owner chip still names the Bot; a Bot with nothing at all stays out.
  expect(scopes).toEqual([{ botId: 'origin', directories: [], sessionIds: [], delegatedSessionIds: ['child'] }]);
});
