/** Native configuration contract, with disposable HOME and no model requests or user credentials. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeDisabledSkillOverrides, skillEntryPath } from './skill-activation.js';
import { scanClaudeRuntimeSkills } from '../claude-code/customization-scanner.js';

const repo = fileURLToPath(new URL('../../../../..', import.meta.url));
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = (name: string) => path.join(repo, 'apps', `${name}-bin`, `${process.platform}-${process.arch}`, `${name === 'claude-code' ? 'claude' : name}${suffix}`);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-native-skill-policy-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  return { root, home, cwd };
}
function writeSkill(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Disposable test Skill\n---\nTest only.\n`);
}
function rpc(args: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; initial: unknown;
  onMessage: (value: any, send: (request: unknown) => void) => unknown | undefined }): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.binary, args.args, { cwd: args.cwd, env: args.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let result: unknown;
    let failure: Error | undefined;
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => { failure = new Error('Native Skill discovery timed out'); child.kill('SIGKILL'); }, 15_000);
    const send = (request: unknown) => child.stdin.write(JSON.stringify(request) + '\n');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1000); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim() || result !== undefined) continue;
        try {
          result = args.onMessage(JSON.parse(line), send);
          if (result !== undefined) child.kill();
        } catch (error) { failure = error as Error; child.kill(); }
      }
    });
    child.on('error', (error) => { failure = error; });
    child.on('close', () => {
      clearTimeout(timer);
      if (failure || result === undefined) reject(failure ?? new Error(`Native discovery exited: ${stderr}`));
      else resolve(result);
    });
    send(args.initial);
  });
}
function safeEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), HOME: home, USERPROFILE: home };
}

describe('pinned native Skill activation', () => {
  it.skipIf(!fs.existsSync(binary('claude-code')))('disables ancestor Skills using native Git boundaries and nearest-source precedence', async () => {
    const { root, home, cwd: project } = fixture();
    const cwd = path.join(project, 'src');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(project, '.git'));
    const ancestor = path.join(project, '.claude', 'skills', 'ancestor');
    const parentCopy = path.join(project, '.claude', 'skills', 'same');
    const childCopy = path.join(cwd, '.claude', 'skills', 'same');
    const outside = path.join(root, '.claude', 'skills', 'outside');
    writeSkill(ancestor, 'ancestor');
    writeSkill(parentCopy, 'parent-copy');
    writeSkill(childCopy, 'child-copy');
    writeSkill(outside, 'outside');
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const { items } = await scanClaudeRuntimeSkills(cwd);
      expect(items.some((item) => item.name === 'outside')).toBe(false);
      const settings = (disabled: string[]) => claudeDisabledSkillOverrides(items, disabled);
      expect(settings([ancestor, parentCopy, outside])).toEqual({ ancestor: 'off' });
      expect(settings([childCopy])).toEqual({ same: 'off' });
      const commands = async (disabled: string[]) => rpc({ binary: binary('claude-code'), cwd,
        env: { ...safeEnv(home), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
          '--settings', JSON.stringify({ apiKeyHelper: '', skillOverrides: settings(disabled) })],
        initial: { type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } },
        onMessage: (data) => data.type === 'control_response' ? data.response.response.commands.map((item: { name: string }) => item.name) : undefined,
      });
      expect(await commands([])).toEqual(expect.arrayContaining(['ancestor', 'child-copy']));
      const disabled = await commands([ancestor, parentCopy]);
      expect(disabled).not.toContain('ancestor');
      expect(disabled).toContain('child-copy');
      expect(disabled).not.toContain('outside');
      expect(await commands([childCopy])).not.toContain('child-copy');
      // Worktree Git markers are files; discovery still stops there.
      fs.rmdirSync(path.join(project, '.git'));
      fs.writeFileSync(path.join(project, '.git'), 'gitdir: /fixture-only');
      expect((await scanClaudeRuntimeSkills(cwd)).items.some((item) => item.name === 'outside')).toBe(false);
      fs.unlinkSync(path.join(project, '.git'));
      expect((await scanClaudeRuntimeSkills(cwd)).items.some((item) => item.name === 'outside')).toBe(true);
    } finally { homeSpy.mockRestore(); }
  });

  it.skipIf(!fs.existsSync(binary('claude-code')))('Claude disables by directory identity even when the frontmatter name differs', async () => {
    const { home, cwd } = fixture();
    const source = path.join(home, '.claude', 'skills', 'directory-name');
    writeSkill(source, 'native-name');
    const env = { ...safeEnv(home), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const commands = async (disabled: string[]) => rpc({ binary: binary('claude-code'), cwd, env,
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', JSON.stringify({
        apiKeyHelper: '', skillOverrides: claudeDisabledSkillOverrides([
          { engine: 'claude-code', kind: 'skill', scope: 'global', name: 'directory-name', absolutePath: source },
        ], disabled),
      })],
      initial: { type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } },
      onMessage: (data) => data.type === 'control_response' ? data.response.response.commands.map((item: { name: string }) => item.name) : undefined,
    });
    expect(await commands([])).toContain('native-name');
    expect(await commands([source])).not.toContain('native-name');
    expect(await commands([])).toContain('native-name');
    expect(fs.existsSync(path.join(source, 'SKILL.md'))).toBe(true);
  });

  it.skipIf(!fs.existsSync(binary('codex')))('Codex matches physical Skill identity through a shared discovery link', async () => {
    const { root, home, cwd } = fixture();
    const config = path.join(root, 'codex-home');
    fs.mkdirSync(config);
    const source = path.join(root, 'external', 'source');
    writeSkill(source, 'native-name');
    const alias = path.join(home, '.agents', 'skills', 'alias');
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const skills = async (disabled: boolean) => {
      fs.writeFileSync(path.join(config, 'config.toml'), disabled
        ? `[skills]\nconfig = [{ path = ${JSON.stringify(skillEntryPath(source))}, enabled = false }]\n` : '');
      return rpc({ binary: binary('codex'), args: ['app-server'], cwd, env: { ...safeEnv(home), CODEX_HOME: config },
        initial: { id: 1, method: 'initialize', params: { clientInfo: { name: 'cindy_test', version: '1' }, capabilities: { experimentalApi: true } } },
        onMessage: (data, send) => {
          if (data.error) throw new Error(JSON.stringify(data.error));
          if (data.id === 1) {
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } });
          }
          return data.id === 2 ? data.result.data.flatMap((group: { skills: unknown[] }) => group.skills) : undefined;
        },
      });
    };
    expect(await skills(true)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'native-name', enabled: false })]));
    expect(await skills(false)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'native-name', enabled: true })]));
    expect(fs.readlinkSync(alias)).toBe(source);
  });
});
