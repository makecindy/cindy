import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

it('uninstall waits for actual Node exit before removing plugin files and cache', () => {
  const start = source.indexOf('async function uninstallGhostAndCleanupLocked(');
  const body = source.slice(start, source.indexOf('\n}', start));
  const wait = body.indexOf('await getGhostNodeRuntimeBroker().stopAndWait(id)');
  expect(wait).toBeGreaterThan(0);
  expect(body.indexOf('await manager.uninstall(')).toBeGreaterThan(wait);
  expect(body.indexOf('await pluginDownloads.removePlugin(')).toBeGreaterThan(wait);
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
  );
  const work = quit();
  await Promise.resolve();
  expect(events).toEqual(['drained', 'stopping']);
  finish();
  await work;
  expect(events).toEqual(['drained', 'stopping', 'removed']);
});
