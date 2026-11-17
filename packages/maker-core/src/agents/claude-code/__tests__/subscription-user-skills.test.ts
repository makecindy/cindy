/**
 * 本机订阅会话不加载用户级设置(见 subscription-settings-isolation.ts),
 * palette 也不能列出 `~/.claude` 里的命令 / skill:列出来选了也用不了。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return logger; },
  };
  return logger;
}

function createAgent(): ClaudeCodeAgent {
  const deps: AgentDeps = {
    auth: {
      async getState() { return { authenticated: true }; },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    },
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
  };
  return new ClaudeCodeAgent(deps);
}

async function writeCommand(dir: string, name: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.md`), `---\ndescription: ${name}\n---\nbody\n`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ClaudeCodeAgent.listAgentSkills user scope', () => {
  it('omits ~/.claude entries when the session does not load user settings, keeping project entries', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-sub-home-'));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-sub-project-'));
    tempDirs.push(home, project);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await writeCommand(path.join(home, '.claude', 'commands'), 'global-cmd');
    await writeCommand(path.join(project, '.claude', 'commands'), 'project-cmd');
    const agent = createAgent();

    const all = await agent.listAgentSkills({ workingDir: project });
    expect(all.skills.map((skill) => skill.name).sort()).toEqual(['global-cmd', 'project-cmd']);

    const subscription = await agent.listAgentSkills({ workingDir: project, omitUserScopeSkills: true });
    expect(subscription.skills.map((skill) => skill.name)).toEqual(['project-cmd']);
  });
});
