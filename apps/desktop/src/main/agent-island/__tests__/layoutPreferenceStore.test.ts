import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AgentIslandLayoutPreference } from '../geometry.js';

const mocks = vi.hoisted(() => ({
  userDataPath: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userDataPath,
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

function settingsFilePath(): string {
  return path.join(mocks.userDataPath, 'agent-island-layout-settings.json');
}

beforeEach(() => {
  mocks.userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-agent-island-layout-'));
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(mocks.userDataPath, { recursive: true, force: true });
});

it('reads the legacy displays-only format without creating detached preferences', async () => {
  fs.writeFileSync(
    settingsFilePath(),
    JSON.stringify({
      displays: {
        7: {
          compactContentWidth: 420,
          displayName: 'Mi Monitor',
        },
      },
    }),
  );
  const store = await import('../layoutPreferenceStore.js');

  expect(store.readAgentIslandLayoutPreferences().get(7)).toEqual({
    compactContentWidth: 420,
    displayName: 'Mi Monitor',
    displayBounds: undefined,
  });
  expect(store.readAgentIslandDetachedLayoutPreferences()).toEqual([]);
});

it('preserves detached preferences during a single-display write', async () => {
  fs.writeFileSync(
    settingsFilePath(),
    JSON.stringify({
      displays: {
        1: { compactContentWidth: 300 },
      },
      detachedDisplays: [
        {
          compactContentWidth: 500,
          centerXRatio: 0.25,
          displayName: 'Mi Monitor',
          displayInternal: false,
          displayBounds: { x: 1728, y: 0, width: 1512, height: 982 },
        },
      ],
    }),
  );
  const store = await import('../layoutPreferenceStore.js');

  store.writeAgentIslandLayoutPreference(1, { compactContentWidth: 320 });

  const persisted = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf-8')) as {
    displays: Record<string, AgentIslandLayoutPreference>;
    detachedDisplays: AgentIslandLayoutPreference[];
  };
  expect(persisted.displays['1']).toEqual({ compactContentWidth: 320 });
  expect(persisted.detachedDisplays).toEqual([
    expect.objectContaining({
      compactContentWidth: 500,
      displayName: 'Mi Monitor',
    }),
  ]);
});

it('round-trips a complete active and detached preference snapshot', async () => {
  const store = await import('../layoutPreferenceStore.js');
  store.writeAgentIslandLayoutPreferences(
    new Map<number, AgentIslandLayoutPreference>([
      [
        2,
        {
          compactContentWidth: 300,
          displayName: 'Built-in Retina Display',
          displayInternal: true,
        },
      ],
    ]),
    [
      {
        compactContentWidth: 500,
        displayName: 'Mi Monitor',
        displayInternal: false,
      },
    ],
  );
  vi.resetModules();
  const reloaded = await import('../layoutPreferenceStore.js');

  expect(reloaded.readAgentIslandLayoutPreferences().get(2)).toEqual(
    expect.objectContaining({
      compactContentWidth: 300,
      displayName: 'Built-in Retina Display',
    }),
  );
  expect(reloaded.readAgentIslandDetachedLayoutPreferences()).toEqual([
    expect.objectContaining({
      compactContentWidth: 500,
      displayName: 'Mi Monitor',
    }),
  ]);
});
