import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIOSSimulatorPreferencesStore } from '../ios-simulator-preferences.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true })));
});

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-ios-preferences-'));
  cleanupPaths.push(root);
  const file = path.join(root, 'ios-simulator-preferences.json');
  return {
    file,
    store: createIOSSimulatorPreferencesStore({ filePath: () => file }),
  };
}

describe('iOS Simulator preferences', () => {
  it('defaults to automatically opening the embedded panel', async () => {
    const { store } = await createStore();

    expect(store.read()).toEqual({ autoOpenEmbeddedPanel: true });
  });

  it('persists an opt-out and reloads it from disk', async () => {
    const { file, store } = await createStore();

    await expect(store.writeAutoOpenEmbeddedPanel(false)).resolves.toEqual({
      autoOpenEmbeddedPanel: false,
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      autoOpenEmbeddedPanel: false,
    });

    const reloaded = createIOSSimulatorPreferencesStore({ filePath: () => file });
    expect(reloaded.read()).toEqual({ autoOpenEmbeddedPanel: false });
  });

  it('removes the override after restoring the default', async () => {
    const { file, store } = await createStore();
    await store.writeAutoOpenEmbeddedPanel(false);

    await expect(store.writeAutoOpenEmbeddedPanel(true)).resolves.toEqual({
      autoOpenEmbeddedPanel: true,
    });
    await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back to the default for an invalid persisted value', async () => {
    const { file, store } = await createStore();
    await writeFile(file, JSON.stringify({ autoOpenEmbeddedPanel: 'false' }), 'utf8');

    expect(store.read()).toEqual({ autoOpenEmbeddedPanel: true });
  });
});
