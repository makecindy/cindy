import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

it('uninstall waits for actual Node exit before removing plugin files and cache', () => {
  const start = source.indexOf('async function uninstallGhostAndCleanupLocked(');
  const body = source.slice(start, source.indexOf('\n}', start));
  const wait = body.indexOf('await getGhostNodeRuntimeBroker().stopAndWait(storagePart)');
  expect(wait).toBeGreaterThan(0);
  expect(body.indexOf('runtime.stop(storagePart)')).toBeGreaterThan(0);
  expect(body.indexOf('runtime.stop(storagePart)')).toBeLessThan(wait);
  expect(body.indexOf('await mutation.uninstall(')).toBeGreaterThan(wait);
  expect(body.indexOf('await pluginDownloads.removePlugin(')).toBeGreaterThan(wait);
});

it('Node receipt handoff rechecks the original logic page identity after acquiring files', () => {
  const start = source.indexOf("if (type === 'node-request')");
  const body = source.slice(start, source.indexOf('\n    }', start));
  expect(body).toContain('pluginDownloads.withNodeDownloads(');
  expect(body).toContain(
    '!event.sender.isDestroyed() && ghostIdForLogicWebContents(event.sender.id) === id',
  );
});

it('quit awaits download drain and Node exit before removing captured anonymous roots', async () => {
  const start = source.indexOf("onQuit('plugin-downloads'");
  const end = source.indexOf("'async');", start) + "'async');".length;
  const js = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
  const events: string[] = [];
  let quit!: () => Promise<void>;
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  new Function(
    'onQuit',
    'pluginDownloads',
    'anonymousDownloadRoots',
    'getGhostNodeRuntimeBroker',
    'stopPluginAppInstance',
    js,
  )(
    (_name: string, fn: () => Promise<void>, phase: string) => {
      expect(phase).toBe('async');
      quit = fn;
    },
    {
      stopAndWait: async () => {
        events.push('drained');
      },
      removePlugin: async (...args: string[]) => {
        expect(args).toEqual(['p', '/captured-anonymous/p', 'old-scope']);
        events.push('removed');
      },
    },
    new Map([['p', { root: '/captured-anonymous/p', scope: 'old-scope' }]]),
    () => ({
      stopAndWait: async () => {
        events.push('stopping');
        await exited;
      },
    }),
    async () => { events.push('mcp-stopped'); },
  );
  const work = quit();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(events).toEqual(['drained', 'mcp-stopped', 'stopping']);
  finish();
  await work;
  expect(events).toEqual(['drained', 'mcp-stopped', 'stopping', 'removed']);
});

import { vi } from 'vitest';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
const createUninstall = createGhostProductionCallbacks<{
  uninstallGhostAndCleanupLocked(id: string, options: { skipMarketLedger: boolean }): Promise<void>;
}>({ functions: ['uninstallGhostAndCleanupLocked'] });
// MCP can write fs data directly. Uninstall must wait for exit before removing
// either the package or root:data. Existing Node-only ordering missed this owner.
it.each([false, true])('uninstall cannot delete private data before MCP exits (failed=%s)', async (failed) => {
  let finish!: () => void;
  const exit = new Promise<void>(resolve => { finish = resolve; });
  const events: string[] = [];
  const noop = () => {};
  const clear = { clearGhost: noop, dropGhost: noop };
  const ghost = { manifest: { id: 'fixture', name: 'Fixture' }, dir: '/plugins/fixture' };
  const manager = { list: () => [], runExclusiveMutation: async (run: (m: unknown) => Promise<void>) =>
    run({ uninstall: async () => { events.push('package-removed'); return {}; } }) };
  const { uninstallGhostAndCleanupLocked } = createUninstall({
    beginGhostMutation: () => noop, requireGhostAvailableForActiveSession: noop,
    findGhostForInstanceId: () => ghost, getBotAuthorizationService: () => null,
    getGhostManager: () => manager, getGhostRuntime: () => ({ stop: noop }),
    pluginDeviceSync: { beginMutation: () => noop },
    stopPluginAppInstance: async () => { await exit; if (failed) throw new Error('stop failed'); events.push('ui-revoked'); },
    getGhostNodeRuntimeBroker: () => ({ stopAndWait: async () => {} }),
    getGhostAgentSlot: () => clear, harnessSlotSingleton: null,
    getGhostErrandSlot: () => clear, getGhostSubscriptionGateway: () => clear,
    ownerScopedUserDataPath: (...parts: string[]) => '/owner/' + parts.join('/'), activeOwnerScopeKey: () => 'owner',
    pluginTaskUninstaller: async (_id: string, run: () => Promise<void>) => run(), currentPluginUsageService: () => null,
    pluginDownloads: { removePlugin: async () => {} }, removeGhostSecrets: noop,
    removeGhostKvBestEffort: noop, createGhostKvStore: () => ({}), log: { warn: noop, info: noop },
    fs: { promises: { rm: vi.fn(async (dir: string) => { expect(dir).toBe('/owner/ghost-fs/fixture'); events.push('data-removed'); }) } },
    getGhostLibrarySlot: () => { throw new Error('no library'); },
    ledger: { removeRefs: async () => 0 }, forgetGhostRecentUsage: () => null,
    forgetGhostRecommendations: noop, extinguishGhostUnread: noop, badgeSlotSingleton: null,
    broadcastGhostsChanged: noop,
  });
  const work = uninstallGhostAndCleanupLocked('fixture', { skipMarketLedger: true });
  const result = failed ? expect(work).rejects.toThrow('stop failed') : expect(work).resolves.toBeUndefined();
  await Promise.resolve(); expect(events).toEqual([]);
  finish(); await result;
  expect(events).toEqual(failed ? [] : ['ui-revoked', 'package-removed', 'data-removed']);
});
