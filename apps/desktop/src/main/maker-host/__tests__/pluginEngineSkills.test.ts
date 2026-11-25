import { describe, expect, it, vi } from 'vitest';
import { createPluginEngineSkillLister } from '../pluginEngineSkills';

// Review (#12294, Codex P2)：插件引擎首轮 Skill 清单此前经 Pi 的同步目录扫描在 Main 上执行，大或慢的 Skill 目录会
// 阻塞其他任务。生产入口 installPluginEngines → AcpAgent 调用的 listSessionSkills 即本函数。覆盖缺口：目录发现必须走
// 隔离的扫描进程，并保留 Cindy 管理/插件 Skill 与用户启用开关。最小失败输入：一个托管 Skill、两个扫描到的 Skill
// （其一被用户停用、其一被引擎标为未启用）。unit tier。
describe('plugin-engine Skill list', () => {
  it('discovers folders through the isolated scan and keeps managed Skills and enable switches', async () => {
    const scanCustomizations = vi.fn(async () => ({
      errors: [],
      items: [
        { engine: 'pi' as const, kind: 'skill', scope: 'user', name: 'review', description: 'Review code', absolutePath: '/skills/review', mdPath: '/skills/review/SKILL.md' },
        { engine: 'pi' as const, kind: 'skill', scope: 'repo', name: 'off', description: 'Turned off', absolutePath: '/repo/.agents/skills/off' },
        { engine: 'pi' as const, kind: 'skill', scope: 'user', name: 'disabled-by-engine', absolutePath: '/skills/x', enabled: false },
      ],
    }));
    const list = createPluginEngineSkillLister({
      listManagedSkills: async () => [{ name: 'pr', description: 'Carry a PR', path: '/managed/pr/SKILL.md' }],
      scanCustomizations,
      readDisabledSkillPaths: () => ['/repo/.agents/skills/off/SKILL.md'],
    });
    expect(await list({ workingDir: '/repo' })).toEqual([
      { name: 'pr', description: 'Carry a PR', path: '/managed/pr/SKILL.md' },
      { name: 'review', description: 'Review code', path: '/skills/review/SKILL.md' },
    ]);
    expect(scanCustomizations).toHaveBeenCalledWith('pi', { workingDirs: ['/repo'], kinds: ['skill'] });
  });
});
