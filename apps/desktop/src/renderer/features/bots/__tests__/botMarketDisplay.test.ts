import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { botRoutineRhythm, bundledPluginNames } from '../botMarketDisplay';

const t = (key: string, options?: Record<string, unknown>) => options?.count === undefined ? key : `${key}:${options.count}`;

it('turns even minute lists and steps into "every N minutes", and only localizable shapes into words', () => {
  expect(botRoutineRhythm('0,30 * * * *', t, 'zh-CN')).toBe('routines.everyMinutes:30');
  expect(botRoutineRhythm('*/15 * * * *', t, 'zh-CN')).toBe('routines.everyMinutes:15');
  expect(botRoutineRhythm('0,15,30,45 * * * *', t, 'zh-CN')).toBe('routines.everyMinutes:15');
  expect(botRoutineRhythm('0 * * * *', t, 'zh-CN')).toBe('routines.hourly');
  expect(botRoutineRhythm('0 8 * * *', t, 'zh-CN')).toBe('scheduler.builtinTemplates.schedule.daily');
  expect(botRoutineRhythm('0 13 * * 1-5', t, 'zh-CN')).toBe('scheduler.builtinTemplates.schedule.weekdays');
  expect(botRoutineRhythm('0 9 * * 3', t, 'zh-CN')).toBe('scheduler.builtinTemplates.schedule.weekly');
  // Uneven lists, odd gaps and shapes the shared formatter would print in English are hidden.
  for (const cron of ['0,20,30 * * * *', '5,35 * * * *', '*/7 * * * *', '15 3 1 6 *', '0 9 * * 0,6', 'not a cron']) {
    expect(botRoutineRhythm(cron, t, 'zh-CN'), cron).toBeUndefined();
  }
});
it('names every plugin a bundled package depends on', async () => {
  const root = path.resolve('resources/bot-packages');
  const missing: string[] = [];
  for (const id of await fs.readdir(root)) {
    const versions = await fs.readdir(path.join(root, id));
    for (const version of versions) {
      const manifest = JSON.parse(await fs.readFile(path.join(root, id, version, 'manifest.json'), 'utf8')) as { dependencies: { plugins: Array<{ id: string }> } };
      for (const plugin of manifest.dependencies.plugins) if (!(plugin.id in bundledPluginNames)) missing.push(`${id}: ${plugin.id}`);
    }
  }
  expect(missing).toEqual([]);
});
