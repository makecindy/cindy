/**
 * loadAllCommands 的 deviceId 透传单测(device-link「以被控端为准」)。
 * 远程会话:agent-builtin / agent-skill 走隧道从被控端读;desktop 命令列表始终本地
 * (控制端 UI,见 D2),且**全量可用** —— /goal /learn /cmd 的业务体由 main 按
 * ctx.deviceId 隧道路由到被控端,不再有静态黑名单剔除。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAllCommands } from '@/lib/slashCommands';

beforeEach(() => {
  vi.unstubAllGlobals();
});

function c(name: string, kind: string) {
  return { name, kind } as unknown as import('@cindy/maker-core').UnifiedCommand;
}

function stubElectron() {
  // desktop 含 goal:device-link 远程会话下同样保留(main 按 ctx.deviceId 隧道路由到被控端)。
  const listDesktopCommands = vi.fn(async () => ({
    success: true,
    commands: [c('help', 'desktop'), c('goal', 'desktop')],
  }));
  const listAgentCommands = vi.fn(async () => ({
    success: true,
    commands: [c('compact', 'agent-builtin')],
  } as {
    success: boolean;
    commands: import('@cindy/maker-core').UnifiedCommand[];
    runtimeStatus?: import('../../shared/piPackages').PiPackageCommandRuntimeStatus;
  }));
  const listAgentSkills = vi.fn(async () => ({ success: true, skills: [c('localskill', 'agent-skill')] }));
  const invoke = vi.fn(async (_deviceId: string, channel: string, args?: unknown[]) => {
    if (channel === 'maker:list-agent-commands') {
      return args?.[0] === 'pi'
        ? {
            success: true,
            commands: [c('host-extension-cmd', 'agent-builtin')],
            runtimeStatus: 'loaded',
          }
        : { success: true, commands: [c('host-cmd', 'agent-builtin')] };
    }
    if (channel === 'maker:list-agent-skills') return { success: true, skills: [c('host-skill', 'agent-skill')] };
    return { success: false };
  });
  vi.stubGlobal('window', {
    electronAPI: {
      maker: { listDesktopCommands, listAgentCommands, listAgentSkills },
      deviceLink: { invoke },
    },
  });
  return { listDesktopCommands, listAgentCommands, listAgentSkills, invoke };
}

describe('loadAllCommands deviceId', () => {
  it('本地会话(无 deviceId):三源全本地,不碰隧道', async () => {
    const s = stubElectron();
    const cmds = await loadAllCommands('claude-code', '/w', { sessionId: 'local-session' });
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.listAgentCommands).toHaveBeenCalledWith('claude-code', { sessionId: 'local-session' });
    expect(s.listAgentSkills).toHaveBeenCalledWith('claude-code', {
      workingDir: '/w',
      sessionId: 'local-session',
    });
    // 本地会话:goal 命令保留(可对本地 session 设目标)。
    expect(cmds.map((x) => x.name).sort()).toEqual(['compact', 'goal', 'help', 'localskill']);
  });

  it('本地 Claude 新对话 workingDir=null 时仍加载全局 skills', async () => {
    const s = stubElectron();
    const cmds = await loadAllCommands('claude-code', null);

    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.listAgentSkills).toHaveBeenCalledWith('claude-code', {});
    expect(cmds.some((x) => x.name === 'localskill')).toBe(true);
  });

  it('SSH remote 用 skipAgentSkills 显式关闭控制端本机 skill 扫描', async () => {
    const s = stubElectron();
    const cmds = await loadAllCommands('claude-code', null, { skipAgentSkills: true });

    expect(s.listAgentSkills).not.toHaveBeenCalled();
    expect(s.invoke).not.toHaveBeenCalledWith(
      expect.anything(),
      'maker:list-agent-skills',
      expect.anything(),
    );
    expect(cmds.some((x) => x.kind === 'agent-skill')).toBe(false);
  });

  it('SSH remote 新 Pi 对话不请求控制端本机包预览', async () => {
    const s = stubElectron();
    await loadAllCommands('pi', null, {
      skipAgentSkills: true,
      allowManagedPiPackagePreview: false,
    });

    expect(s.listAgentCommands).toHaveBeenCalledWith('pi', {
      allowManagedPiPackagePreview: false,
    });
  });

  it('reports a pending Pi runtime catalog so the open palette can retry', async () => {
    const s = stubElectron();
    s.listAgentCommands.mockResolvedValueOnce({
      success: true,
      commands: [c('compact', 'agent-builtin')],
      runtimeStatus: 'pending',
    });
    const onPiRuntimeStatus = vi.fn();

    await loadAllCommands('pi', null, {
      sessionId: 'pi-session',
      onPiRuntimeStatus,
    });

    expect(onPiRuntimeStatus).toHaveBeenCalledWith('pending');
  });

  it('本地 Codex 新对话 workingDir=null 时仍加载全局 skills', async () => {
    const s = stubElectron();
    const cmds = await loadAllCommands('codex', null);

    expect(s.listAgentSkills).toHaveBeenCalledWith('codex', {});
    expect(cmds.some((x) => x.name === 'localskill')).toBe(true);
  });

  it('远程会话:agent-builtin / agent-skill 走隧道,desktop 仍本地', async () => {
    const s = stubElectron();
    const cmds = await loadAllCommands(
      'claude-code',
      '/host/path',
      { sessionId: 'remote-session' },
      'dev-1',
    );
    // desktop 始终本地
    expect(s.listDesktopCommands).toHaveBeenCalled();
    // agent-builtin / agent-skill 不走本地、走隧道
    expect(s.listAgentCommands).not.toHaveBeenCalled();
    expect(s.listAgentSkills).not.toHaveBeenCalled();
    expect(s.invoke).toHaveBeenCalledWith('dev-1', 'maker:list-agent-commands', [
      'claude-code',
      { sessionId: 'remote-session' },
    ]);
    expect(s.invoke).toHaveBeenCalledWith('dev-1', 'maker:list-agent-skills', [
      'claude-code',
      { workingDir: '/host/path', sessionId: 'remote-session' },
    ]);
    // 结果 = 本地 desktop(help + goal,远程会话不再剔除)+ 被控端 builtin(host-cmd)+ 被控端 skill(host-skill)
    expect(cmds.map((x) => x.name).sort()).toEqual(['goal', 'help', 'host-cmd', 'host-skill']);
    // device-link 下 /goal 保留:业务体经隧道到被控端 goal-host,palette 正常展示。
    expect(cmds.some((x) => x.name === 'goal')).toBe(true);
  });

  it('device-link Claude 新对话 workingDir=null 时从被控端加载全局 skills', async () => {
    const s = stubElectron();
    const cmds = await loadAllCommands('claude-code', null, undefined, 'dev-1');

    expect(s.listAgentSkills).not.toHaveBeenCalled();
    expect(s.invoke).toHaveBeenCalledWith('dev-1', 'maker:list-agent-skills', [
      'claude-code',
      {},
    ]);
    expect(cmds.some((x) => x.name === 'host-skill')).toBe(true);
  });

  it('device-link Pi 直接使用被控主机 runtime 返回的扩展命令', async () => {
    const s = stubElectron();
    const onPiRuntimeStatus = vi.fn();
    const cmds = await loadAllCommands(
      'pi',
      '/host/path',
      { sessionId: 'host-pi-session', onPiRuntimeStatus },
      'dev-1',
    );

    // 控制端不扫描自己的 Pi 扩展目录；整份命令目录由被控主机的 Cindy 返回。
    expect(s.listAgentCommands).not.toHaveBeenCalled();
    expect(s.invoke).toHaveBeenCalledWith('dev-1', 'maker:list-agent-commands', [
      'pi',
      { sessionId: 'host-pi-session' },
    ]);
    expect(cmds.some((x) => x.name === 'host-extension-cmd')).toBe(true);
    expect(cmds.some((x) => x.name === 'compact')).toBe(false);
    expect(onPiRuntimeStatus).toHaveBeenCalledWith('loaded');
  });
});
