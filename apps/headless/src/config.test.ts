import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessConfigStore, resolveHeadlessDefaults } from './config.js';

const dirs: string[] = [];
function store(): HeadlessConfigStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-config-'));
  dirs.push(dir);
  return new HeadlessConfigStore(path.join(dir, 'config.json'));
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessConfigStore', () => {
  it('keeps user defaults sparse while resolving safe product defaults', async () => {
    const subject = store();
    const config = await subject.read();
    expect(config.defaults).toEqual({});
    expect(resolveHeadlessDefaults(config).permissionMode).toBe('ask');
    expect(config.remoteControlEnabled).toBe(false);
    await subject.write({ ...config, remoteControlEnabled: true, defaults: { ...config.defaults, model: 'gpt-5.6' } });
    await expect(subject.read()).resolves.toMatchObject({ remoteControlEnabled: true, defaults: { model: 'gpt-5.6' } });
  });

  it('gives a workdir override precedence over the user override', async () => {
    const subject = store();
    const config = await subject.read();
    await subject.write({
      ...config,
      defaults: { model: 'gpt-user', effort: 'medium' },
      projectDefaults: { '/srv/work/api': { model: 'gpt-project' } },
    });
    const restored = await subject.read();
    expect(resolveHeadlessDefaults(restored, '/srv/work/api')).toMatchObject({ model: 'gpt-project', effort: 'medium' });
  });
});
