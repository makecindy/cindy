import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanClaudePluginSkills } from './claude-plugin-skills.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plugin-skills-'));
  roots.push(root);
  return root;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function writeSkill(folder: string, name: string): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name}\n---\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('scanClaudePluginSkills', () => {
  it('lists enabled plugins with a plugin:skill namespace and skips disabled ones', () => {
    const configDir = tempRoot();
    const alpha = path.join(configDir, 'plugins', 'cache', 'alpha');
    const beta = path.join(configDir, 'plugins', 'cache', 'beta');
    writeSkill(path.join(alpha, 'skills', 'one'), 'one');
    writeSkill(path.join(alpha, 'skills', 'two'), 'two');
    writeSkill(path.join(beta, 'skills', 'hidden'), 'hidden');
    writeJson(path.join(alpha, '.claude-plugin', 'plugin.json'), { name: 'alpha' });
    writeJson(path.join(beta, '.claude-plugin', 'plugin.json'), { name: 'beta' });
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'alpha@market': [{ installPath: alpha }],
        'beta@market': [{ installPath: beta }],
      },
    });
    writeJson(path.join(configDir, 'settings.json'), {
      enabledPlugins: { 'alpha@market': true, 'beta@market': false },
    });

    const skills = scanClaudePluginSkills(configDir);

    expect(skills.map((skill) => skill.name)).toEqual(['alpha:one', 'alpha:two']);
    expect(skills[0]?.mdPath).toBe(path.join(alpha, 'skills', 'one', 'SKILL.md'));
  });

  it('honours a manifest skills path and defaults to skills/', () => {
    const configDir = tempRoot();
    const plugin = path.join(configDir, 'plugins', 'cache', 'gamma');
    writeSkill(path.join(plugin, 'custom-skills', 'deep'), 'deep');
    writeJson(path.join(plugin, '.claude-plugin', 'plugin.json'), {
      name: 'gamma',
      skills: './custom-skills/',
    });
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      plugins: { 'gamma@market': [{ installPath: plugin }] },
    });

    expect(scanClaudePluginSkills(configDir).map((skill) => skill.name)).toEqual([
      'gamma:deep',
    ]);
  });

  it('returns an empty list when plugin metadata is missing or malformed', () => {
    const configDir = tempRoot();
    expect(scanClaudePluginSkills(configDir)).toEqual([]);

    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      plugins: 'nope',
    });
    expect(scanClaudePluginSkills(configDir)).toEqual([]);
  });

  it('prefers the directory marketplace checkout over a stale cached installPath', () => {
    const configDir = tempRoot();
    const repo = path.join(configDir, 'repo');
    const live = path.join(repo, 'plugins', 'nocode');
    const staleCache = path.join(configDir, 'plugins', 'cache', 'nocode', '1.0.0');
    writeSkill(path.join(live, 'skills', 'current'), 'current');
    writeSkill(path.join(staleCache, 'skills', 'outdated'), 'outdated');
    writeJson(path.join(live, '.claude-plugin', 'plugin.json'), { name: 'nocode' });
    writeJson(path.join(staleCache, '.claude-plugin', 'plugin.json'), { name: 'nocode' });
    writeJson(path.join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'nocode-market',
      plugins: [{ name: 'nocode', source: './plugins/nocode' }],
    });
    writeJson(path.join(configDir, 'plugins', 'known_marketplaces.json'), {
      'nocode-market': {
        source: { source: 'directory', path: repo },
        installLocation: repo,
      },
    });
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      plugins: { 'nocode@nocode-market': [{ installPath: staleCache }] },
    });

    expect(scanClaudePluginSkills(configDir).map((skill) => skill.name)).toEqual([
      'nocode:current',
    ]);
  });

  it('falls back to installPath when the marketplace cannot be resolved', () => {
    const configDir = tempRoot();
    const cached = path.join(configDir, 'plugins', 'cache', 'alpha', '1.0.0');
    writeSkill(path.join(cached, 'skills', 'one'), 'one');
    writeJson(path.join(cached, '.claude-plugin', 'plugin.json'), { name: 'alpha' });
    writeJson(path.join(configDir, 'plugins', 'known_marketplaces.json'), {
      'alpha-market': {
        source: { source: 'directory', path: '/nonexistent/repo' },
        installLocation: '/nonexistent/repo',
      },
    });
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      plugins: { 'alpha@alpha-market': [{ installPath: cached }] },
    });

    expect(scanClaudePluginSkills(configDir).map((skill) => skill.name)).toEqual([
      'alpha:one',
    ]);
  });

  it('falls back to installPath when the marketplace checkout directory is gone', () => {
    const configDir = tempRoot();
    const repo = path.join(configDir, 'repo');
    const cached = path.join(configDir, 'plugins', 'cache', 'alpha', '1.0.0');
    writeSkill(path.join(cached, 'skills', 'one'), 'one');
    writeJson(path.join(cached, '.claude-plugin', 'plugin.json'), { name: 'alpha' });
    // The manifest still declares ./plugins/alpha, but that checkout was moved.
    writeJson(path.join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'alpha-market',
      plugins: [{ name: 'alpha', source: './plugins/alpha' }],
    });
    writeJson(path.join(configDir, 'plugins', 'known_marketplaces.json'), {
      'alpha-market': {
        source: { source: 'directory', path: repo },
        installLocation: repo,
      },
    });
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      plugins: { 'alpha@alpha-market': [{ installPath: cached }] },
    });

    expect(scanClaudePluginSkills(configDir).map((skill) => skill.name)).toEqual([
      'alpha:one',
    ]);
  });

  it('ignores project-scoped installs so other projects are not offered their Skills', () => {
    const configDir = tempRoot();
    const projectPlugin = path.join(configDir, 'work', 'repo', '.claude', 'plugins', 'alpha');
    writeSkill(path.join(projectPlugin, 'skills', 'one'), 'one');
    writeJson(path.join(projectPlugin, '.claude-plugin', 'plugin.json'), { name: 'alpha' });
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      plugins: {
        'alpha@market': [{ scope: 'project', installPath: projectPlugin }],
      },
    });

    // Claude only loads project-scoped plugins inside that project; a global
    // Skill list must not advertise commands the session cannot resolve.
    expect(scanClaudePluginSkills(configDir)).toEqual([]);
  });

  it('keeps the conventional skills/ root when the manifest declares extra paths', () => {
    const configDir = tempRoot();
    const plugin = path.join(configDir, 'plugins', 'cache', 'delta');
    writeSkill(path.join(plugin, 'skills', 'conventional'), 'conventional');
    writeSkill(path.join(plugin, 'extra', 'declared'), 'declared');
    writeJson(path.join(plugin, '.claude-plugin', 'plugin.json'), {
      name: 'delta',
      skills: './extra',
    });
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      plugins: { 'delta@market': [{ scope: 'user', installPath: plugin }] },
    });

    // Claude treats a declared skills path as a supplement, not a replacement;
    // omitting skills/ here would hide Skills the running session still loads.
    expect(scanClaudePluginSkills(configDir).map((skill) => skill.name)).toEqual([
      'delta:conventional',
      'delta:declared',
    ]);
  });

  it('keeps a direct Skill whose folder name looks like a build output', () => {
    const configDir = tempRoot();
    const plugin = path.join(configDir, 'plugins', 'cache', 'buildy');
    writeSkill(path.join(plugin, 'skills', 'build'), 'build');
    writeJson(path.join(plugin, '.claude-plugin', 'plugin.json'), { name: 'buildy' });
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      plugins: { 'buildy@market': [{ scope: 'user', installPath: plugin }] },
    });

    // `build` 只在作为 namespace 下钻时才裁剪；目录本身是 Skill 时必须保留，
    // 否则 Claude 能调用的 `/buildy:build` 不会出现在菜单里。
    expect(scanClaudePluginSkills(configDir).map((skill) => skill.name)).toEqual([
      'buildy:build',
    ]);
  });

  it('lists project-scoped installs nowhere while project support is pending', () => {
    const configDir = tempRoot();
    const projectA = path.join(configDir, 'work', 'a');
    const plugin = path.join(configDir, 'plugins', 'cache', 'alpha');
    writeSkill(path.join(plugin, 'skills', 'one'), 'one');
    writeJson(path.join(plugin, '.claude-plugin', 'plugin.json'), { name: 'alpha' });
    writeJson(path.join(configDir, 'plugins', 'installed_plugins.json'), {
      plugins: {
        'alpha@market': [{ scope: 'project', projectPath: projectA, installPath: plugin }],
      },
    });

    // 项目级插件需要项目根、全部候选项目与逐项目 settings 才能定位正确，
    // 在补齐之前一律不展示，避免把只在某个项目生效的条目标成全局。
    expect(scanClaudePluginSkills(configDir)).toEqual([]);
  });
});
