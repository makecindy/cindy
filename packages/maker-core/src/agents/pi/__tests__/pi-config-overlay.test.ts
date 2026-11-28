/**
 * 测试价值
 * - 生产入口与可观察结果：`projectPiConfigOverlay`（config-overlay.ts）的返回值与落盘结果 ——
 *   本次会话 configHome 里出现哪些文件、哪些被拒、稳定根是否被改动。
 * - Bug／规则依据：docs/dev-rules/pi-harness.md §2「用户扩展配置投影」；会话 configHome
 *   每次随机，扩展配置（如 pi-web-access 的 web-search.json）没有稳定落点。
 * - 现有覆盖缺口：pi-settings-passthrough.test.ts 只覆盖 settings.json 内的白名单键，
 *   不覆盖文件级投影与保留名拒绝；也没有用例守住「只单向投影、不写回」。
 * - 最小失败输入：`config-overlay/settings.json`（保留名）被投影进 configHome 会覆盖 Cindy
 *   生成的配置；投影把会话内改动写回稳定根会让 Full access 会话绕过「模型写 agent home
 *   必须用户确认」。
 * - tier：unit（os.tmpdir 下的 mkdtemp，进程内无网络、无子进程）。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PI_CONFIG_OVERLAY_MAX_FILE_BYTES,
  piConfigOverlayDir,
  projectPiConfigOverlay,
} from '../config-overlay.js';

let root = '';
let agentHome = '';
let configHome = '';

async function writeOverlay(name: string, content: string): Promise<void> {
  const dir = piConfigOverlayDir(agentHome);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), content);
}

async function readProjected(name: string): Promise<string> {
  return fs.readFile(path.join(configHome, name), 'utf8');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'pi-config-overlay-'));
  agentHome = path.join(root, 'agent-home');
  configHome = path.join(root, 'config-home');
  await fs.mkdir(configHome, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('projectPiConfigOverlay', () => {
  it('copies flat json config into the session config home', async () => {
    await writeOverlay('web-search.json', '{"tavilyApiKey":"fake-tavily-key"}\n');

    const projection = await projectPiConfigOverlay(agentHome, configHome);

    expect(projection.rejected).toEqual([]);
    expect(projection.error).toBeUndefined();
    expect(projection.entries.map(entry => entry.name)).toEqual(['web-search.json']);
    expect(await readProjected('web-search.json')).toBe('{"tavilyApiKey":"fake-tavily-key"}\n');
    if (process.platform !== 'win32') {
      const stat = await fs.stat(path.join(configHome, 'web-search.json'));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('treats a missing overlay directory as nothing to project', async () => {
    const projection = await projectPiConfigOverlay(agentHome, configHome);

    expect(projection).toEqual({ entries: [], rejected: [] });
    expect(await fs.readdir(configHome)).toEqual([]);
  });

  it('rejects reserved names, non-json, nested entries and invalid json without touching config home', async () => {
    await writeOverlay('settings.json', '{"transport":"sse"}');
    await writeOverlay('notes.txt', 'hello');
    await writeOverlay('broken.json', '{ not json');
    await writeOverlay(`${'x'.repeat(200)}.json`, '{}');
    await fs.mkdir(path.join(piConfigOverlayDir(agentHome), 'nested'));

    const projection = await projectPiConfigOverlay(agentHome, configHome);

    expect(projection.entries).toEqual([]);
    expect(projection.rejected.map(rejection => [rejection.name, rejection.reason])).toEqual([
      ['broken.json', 'invalid-json'],
      ['nested', 'not-a-regular-file'],
      ['notes.txt', 'invalid-name'],
      ['settings.json', 'reserved-name'],
      [`${'x'.repeat(200)}.json`, 'invalid-name'],
    ]);
    expect(await fs.readdir(configHome)).toEqual([]);
  });

  it('rejects a config file that exceeds the size cap', async () => {
    await writeOverlay('huge.json', JSON.stringify({ pad: 'x'.repeat(PI_CONFIG_OVERLAY_MAX_FILE_BYTES) }));

    const projection = await projectPiConfigOverlay(agentHome, configHome);

    expect(projection.entries).toEqual([]);
    expect(projection.rejected).toEqual([{ name: 'huge.json', reason: 'too-large' }]);
  });

  it('projects a snapshot only: later edits in the session never reach the stable root', async () => {
    await writeOverlay('web-search.json', '{"curator":false}\n');
    await projectPiConfigOverlay(agentHome, configHome);

    await fs.writeFile(path.join(configHome, 'web-search.json'), '{"curator":true}\n');
    await fs.rm(configHome, { recursive: true, force: true });

    expect(await fs.readFile(path.join(piConfigOverlayDir(agentHome), 'web-search.json'), 'utf8'))
      .toBe('{"curator":false}\n');
  });
});
