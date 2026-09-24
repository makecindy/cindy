import { describe, expect, it } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
import { vi } from 'vitest';

import os from 'node:os';

import { formatSkillsIndexBlock } from '../skillsIndex';

describe('formatSkillsIndexBlock', () => {
  it('renders name/description lines and empty for none', () => {
    expect(formatSkillsIndexBlock([])).toBe('');
    const block = formatSkillsIndexBlock([
      { name: 'git', description: '通用 Git 工作流', absolutePath: '/skills/git' },
      { name: 'bare', description: '', absolutePath: '/skills/bare' },
    ]);
    expect(block).toContain('- git: 通用 Git 工作流');
    expect(block).toContain('- bare: (no description)');
    expect(block).not.toContain('/skills/git');
    expect(block).not.toContain('/skills/bare');
  });

  it('does not expose local paths in prompt metadata', () => {
    const home = os.homedir();
    const block = formatSkillsIndexBlock([
      { name: 'mine', description: 'd', absolutePath: `${home}/.agents/skills/mine` },
    ]);
    expect(block).toBe('- mine: d');
    expect(block).not.toContain(home);
    expect(block).not.toContain('.agents/skills');
  });

  it('redacts sensitive names and descriptions before prompt injection', () => {
    const secret = 'sk-abcdef1234567890abcdef1234567890';
    const block = formatSkillsIndexBlock([
      {
        name: 'internal-api.corp',
        description: `deploy from /Users/alice/work with ${secret} and alice@example.com`,
        absolutePath: '/skills/private',
      },
    ]);
    expect(block).not.toContain(secret);
    expect(block).not.toContain('/Users/alice');
    expect(block).not.toContain('alice@example.com');
    expect(block).not.toContain('internal-api.corp');
    expect(block).toContain('[REDACTED:api-key]');
    expect(block).toContain('[REDACTED:email]');
    expect(block).toContain('[REDACTED:internal-address]');
  });

  it('notes truncation count', () => {
    const block = formatSkillsIndexBlock(
      [{ name: 'a', description: 'd', absolutePath: '/s/a' }],
      5,
    );
    expect(block).toContain('(5 more installed skill(s) omitted.)');
  });
});

describe('listInstalledSkills — symlink 跟随', () => {
  it('symlink 指向含 SKILL.md 的目录时计入清单;悬空链接跳过', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-skills-idx-'));
    const root = path.join(tmpHome, '.agents', 'skills');
    // 真实目录 skill
    fs.mkdirSync(path.join(root, 'real-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'real-skill', 'SKILL.md'),
      '---\nname: real-skill\ndescription: real one\n---\nBody',
      'utf8',
    );
    // 共享链接流程挂进来的 symlink skill(目标在根外)
    const linkedTarget = path.join(tmpHome, 'elsewhere', 'linked-skill');
    fs.mkdirSync(linkedTarget, { recursive: true });
    fs.writeFileSync(
      path.join(linkedTarget, 'SKILL.md'),
      '---\nname: linked-skill\ndescription: came from claude global\n---\nBody',
      'utf8',
    );
    // 'junction':Windows 无特权也能建目录链接(POSIX 下该参数被忽略,行为不变)。
    fs.symlinkSync(linkedTarget, path.join(root, 'linked-skill'), 'junction');
    // 悬空链接:junction 需要目标存在才能创建,先建再删目标制造悬空。
    const goneTarget = path.join(tmpHome, 'gone');
    fs.mkdirSync(goneTarget, { recursive: true });
    fs.symlinkSync(goneTarget, path.join(root, 'dangling'), 'junction');
    fs.rmdirSync(goneTarget);

    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    try {
      const { listInstalledSkills } = await import('../skillsIndex');
      const { entries } = await listInstalledSkills();
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['linked-skill', 'real-skill']);
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('includes one namespace level and stops at the third level', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-skills-idx-nested-'));
    const root = path.join(tmpHome, '.agents', 'skills');
    const nested = path.join(root, '@scope', 'nested');
    const lower = path.join(root, '@scope', 'lower');
    const tooDeep = path.join(root, '@scope', 'group', 'too-deep');
    const backup = path.join(root, '@scope', 'backup.bak.1', 'ignored');
    for (const skillDir of [nested, tooDeep, backup]) {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${path.basename(skillDir)}\ndescription: nested\n---\nBody`,
        'utf8',
      );
    }
    fs.mkdirSync(lower, { recursive: true });
    fs.writeFileSync(
      path.join(lower, 'skill.md'),
      '---\nname: lower\ndescription: lower-case manifest\n---\nBody',
      'utf8',
    );

    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    try {
      const { listInstalledSkills } = await import('../skillsIndex');
      const { entries } = await listInstalledSkills();
      expect(entries.map((entry) => entry.name).sort()).toEqual(['lower', 'nested']);
      expect(entries.find((entry) => entry.name === 'nested')?.absolutePath).toBe(nested);
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('sorts nested Skills deterministically before truncating at the cap', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-skills-idx-cap-'));
    const root = path.join(tmpHome, '.agents', 'skills');
    // Two namespaces, created in reverse name order so readdir order cannot be
    // relied on; 101 entries exercises SKILLS_INDEX_MAX = 100.
    const names: string[] = [];
    for (let index = 100; index >= 0; index -= 1) {
      const name = `skill-${String(index).padStart(3, '0')}`;
      names.push(name);
      const dir = path.join(root, index % 2 === 0 ? 'zz-ns' : 'aa-ns', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: cap\n---\nBody`,
        'utf8',
      );
    }

    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    try {
      const { listInstalledSkills } = await import('../skillsIndex');
      const { entries, truncatedCount } = await listInstalledSkills();

      expect(entries).toHaveLength(100);
      expect(truncatedCount).toBe(1);
      expect(entries.map((entry) => entry.name)).toEqual(names.sort().slice(0, 100));
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('does not descend through a symlinked namespace', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-skills-idx-link-ns-'));
    const root = path.join(tmpHome, '.agents', 'skills');
    const externalNamespace = path.join(tmpHome, 'external-ns');
    const nested = path.join(externalNamespace, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(nested, 'SKILL.md'),
      '---\nname: linked-nested\ndescription: must not be listed\n---\nBody',
      'utf8',
    );
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(externalNamespace, path.join(root, 'linked-ns'), 'junction');

    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    try {
      const { listInstalledSkills } = await import('../skillsIndex');
      const { entries } = await listInstalledSkills();
      expect(entries).toEqual([]);
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('redacts frontmatter metadata while scanning installed skills', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-skills-idx-redact-'));
    const root = path.join(tmpHome, '.agents', 'skills', 'secret-skill');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'SKILL.md'),
      '---\nname: api.corp\ndescription: token sk-abcdef1234567890abcdef1234567890 for bob@example.com\n---\nBody',
      'utf8',
    );

    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    try {
      const { listInstalledSkills } = await import('../skillsIndex');
      const { entries } = await listInstalledSkills();
      expect(entries[0].name).toBe('[REDACTED:internal-address]');
      expect(entries[0].description).not.toContain('sk-abcdef');
      expect(entries[0].description).not.toContain('bob@example.com');
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
