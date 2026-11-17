/**
 * 测试价值
 * - 可观察结果：同一组本机 Claude 配置、同一份 Cindy 自定义 MCP、同一个 owner 偏好文件，桌面绑定
 *   （mcp-duplicate-preferences.ts）与 Host 的装配（apps/host/src/agent/mcp-duplicate-choices.ts，
 *   Host 自己的代码）给 Claude 构造的 resolveLocalMcpDuplicateChoices 结论相同；偏好由窗口一侧的
 *   saveMcpDuplicateChoice 写入，Host 读到的就是它。
 * - 规则依据：放行表第 19 行 C5。桌面在每次本机 Claude 启动时按这份偏好跳过 Cindy 的重名连接或
 *   拒绝本机的那一条；Host 之前没接，两条都会连上。
 * - 最小失败输入：Host 读别的文件、读不懂时删掉文件、按别的注册表判重、或忽略选择。
 * - tier：unit（真实临时目录与文件；本机配置读取被限制在夹具内，夹具外的路径只记录、不读）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CustomMcpConfig } from '../../../shared/customMcp.js';

const h = vi.hoisted(() => ({
  root: '',
  home: '',
  realHome: '',
  reads: [] as string[],
  actualReads: [] as string[],
  userData: '',
  customs: [] as unknown[],
  builtins: [] as string[],
  tokens: {} as Record<string, string>,
  outside: [] as string[],
}));

// The user home both sides read comes from os.homedir(). Assigning process.env.HOME does not reach it
// in a worker thread (vitest threads pool) or on Windows (USERPROFILE), so the module is mocked.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  h.realHome = actual.homedir();
  const homedir = () => {
    if (!h.home) throw new Error('homedir read before the fixture home was set');
    return h.home;
  };
  return { ...actual, default: { ...actual, homedir }, homedir };
});
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => h.userData } }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ readCustomMcpToken: (id: string) => h.tokens[id] ?? null }));
vi.mock('../../mcp-integrations/custom-mcp-registry.desktop.js', () => ({
  getBuiltinMcpServerNames: () => h.builtins,
  listRegistrableCustomMcpServers: async () => h.customs,
}));
// The ancestor scan reaches past the fixture (up to the filesystem root). Outside the fixture a path
// is only recorded and answered as absent, so no real Claude configuration is read on this machine.
vi.mock('../mcp-duplicate-detection.js', async (importActual) => {
  const actual = await importActual<typeof import('../mcp-duplicate-detection.js')>();
  return {
    ...actual,
    readMcpJson: async (file: string) => {
      h.reads.push(file);
      if (h.root && (file === h.root || file.startsWith(`${h.root}${path.sep}`))) {
        h.actualReads.push(file);
        return actual.readMcpJson(file);
      }
      h.outside.push(file);
      return {};
    },
  };
});

import { configureUserDataDir } from '../../userDataPath.js';
import { commitVolatileAppSession, ownerScopedUserDataPath } from '../../appSessionState.js';
import { listMcpDuplicates, resolveLocalMcpDuplicateChoices, saveMcpDuplicateChoice } from '../mcp-duplicate-preferences.js';

// Explicit bound: real temporary files for both sides.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type HostModule = typeof import('../../../../../host/src/agent/mcp-duplicate-choices.js');
const hostModule = '../../../../../host/src/agent/mcp-duplicate-choices.ts';

describe('Host MCP duplicate choices match the desktop', () => {
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  let home = '';
  let workingDir = '';
  let host: ReturnType<HostModule['createHostMcpDuplicateChoices']>;

  beforeAll(async () => {
    h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-mcp-duplicate-parity-')));
    h.realHome = fs.realpathSync.native(h.realHome);
    home = path.join(h.root, 'home');
    h.home = home;
    workingDir = path.join(h.root, 'project');
    h.userData = path.join(h.root, 'user-data');
    // An empty .git ends the canonical-root search inside the fixture.
    for (const dir of [path.join(home, '.claude'), path.join(workingDir, '.git'), h.userData]) fs.mkdirSync(dir, { recursive: true });
    delete process.env.CLAUDE_CONFIG_DIR;
    configureUserDataDir(h.userData);
    commitVolatileAppSession('local');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {
      'gh-native': { type: 'http', url: 'https://mcp.example.test/mcp' },
      'docs-native': { type: 'sse', url: 'https://docs.example.test/sse/' },
      'unrelated': { type: 'http', url: 'https://other.example.test/mcp' },
    } }));
    const custom = (id: string, url: string): CustomMcpConfig => ({ id, name: id, transport: 'http', url, headers: {} });
    h.customs = [custom('cindy-gh', 'https://mcp.example.test/mcp'), custom('cindy-docs', 'https://docs.example.test/sse')];
    h.builtins = ['cindy_memory'];
    h.tokens = { 'cindy-gh': 'fixture-token' };
    const { createHostMcpDuplicateChoices } = await import(hostModule) as HostModule;
    // Host side: its own module, fed the same registry reads the Host plugin gateway exposes.
    host = createHostMcpDuplicateChoices({
      getBuiltinMcpServerNames: () => h.builtins,
      listRegistrableCustomMcpServers: async () => h.customs as never,
      readCustomMcpToken: (id) => h.tokens[id] ?? null,
    });
  });

  afterAll(() => {
    if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  const both = async () => {
    const input = { env: { HOME: home }, workingDir };
    return { desktop: await resolveLocalMcpDuplicateChoices(input), host: await host.resolveLocalMcpDuplicateChoices(input) };
  };

  it('gives the same answer before any choice and after each choice the window saves', async () => {
    const report = await listMcpDuplicates({ env: { HOME: home }, workingDir });
    expect(report.complete).toBe(true);
    const pairs = Object.fromEntries(report.connections.map(pair => [pair.cindyId, pair.id]));
    expect(Object.keys(pairs).sort()).toEqual(['cindy-docs', 'cindy-gh']);

    const none = await both();
    expect(none.host).toEqual(none.desktop);
    expect(none.desktop).toEqual({ skipHostServers: [], denyNativeServers: [], nativeServersToKeep: [] });

    const answers: Record<string, unknown> = {};
    for (const [id, choice] of [['cindy-gh', 'claude'], ['cindy-docs', 'cindy'], ['cindy-gh', 'both'], ['cindy-gh', null]] as const) {
      // The window's IPC handler writes the owner file; the Host only reads it.
      expect(await saveMcpDuplicateChoice(pairs[id]!, choice)).toBe(true);
      const result = await both();
      expect(result.host).toEqual(result.desktop);
      answers[`${id}:${choice}`] = result.desktop;
    }
    expect(answers['cindy-gh:claude']).toEqual({ skipHostServers: ['cindy-gh'], denyNativeServers: [], nativeServersToKeep: ['gh-native'] });
    expect(answers['cindy-docs:cindy']).toEqual({ skipHostServers: ['cindy-gh'], denyNativeServers: ['docs-native'], nativeServersToKeep: ['gh-native'] });
    expect(answers['cindy-gh:null']).toEqual({ skipHostServers: [], denyNativeServers: ['docs-native'], nativeServersToKeep: [] });
  });

  // Windows regression: the project's physical path must pass the fixture read
  // boundary too; otherwise only user config is tested and project masking is lost.
  it('reads project overrides and masks the user connection on both sides', async () => {
    const file = path.join(workingDir, '.mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'gh-native': { type: 'http', url: 'https://project.example.test/mcp' } } }));
    try {
      const report = await listMcpDuplicates({ env: { HOME: home }, workingDir });
      expect(report.complete).toBe(true);
      expect(report.connections.map(pair => pair.cindyId)).toEqual(['cindy-docs']);
      expect(h.actualReads, JSON.stringify({ root: h.root, file })).toContain(file);
      const result = await both();
      expect(result.host).toEqual(result.desktop);
      expect(result.desktop).toEqual({ skipHostServers: [], denyNativeServers: ['docs-native'], nativeServersToKeep: [] });
    } finally { fs.rmSync(file); }
  });

  it('keeps an unreadable preferences file and answers both sides the same, as without choices', async () => {
    const file = ownerScopedUserDataPath('mcp-duplicate-preferences.json');
    const unreadable = '{"choices": {not-json';
    fs.writeFileSync(file, unreadable);
    const result = await both();
    expect(result.host).toEqual(result.desktop);
    expect(result.desktop).toEqual({ skipHostServers: [], denyNativeServers: [], nativeServersToKeep: [] });
    expect(fs.readFileSync(file, 'utf8')).toBe(unreadable);
  });

  it('read nothing outside the fixture and returns no way to write from the Host', () => {
    // Every path outside the fixture was an ancestor's project file, answered as absent.
    expect(h.outside.length).toBeGreaterThan(0);
    for (const file of h.outside) {
      expect(['.mcp.json', 'settings.json', 'settings.local.json']).toContain(path.basename(file));
      expect(h.root.startsWith(path.dirname(path.basename(file) === '.mcp.json' ? file : path.dirname(file))),
        JSON.stringify({ root: h.root, candidate: file })).toBe(true);
    }
    expect(Object.keys(host)).toEqual(['resolveLocalMcpDuplicateChoices']);
  });

  it('read the user-level configuration from the fixture home, never from the real one', () => {
    expect(h.reads).toContain(path.join(home, '.claude.json'));
    for (const file of h.actualReads) expect(file.startsWith(`${h.root}${path.sep}`),
      JSON.stringify({ root: h.root, actualRead: file })).toBe(true);
    expect(h.reads).not.toContain(path.join(h.realHome, '.claude.json'));
  });
});
