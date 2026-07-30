/**
 * remoteExistingProjects 单测 —— 「添加远程项目」弹窗「已有项目」列表的数据源:
 *   - recentWorkdirsToProjects:被控端 recent_workdirs → 项目(保序 + 同名消歧)
 *   - sshExistingProjects:本地会话按 host 过滤去重 → 项目
 *   - loadDeviceLinkExistingProjects:命中正确隧道 channel/args 并映射
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import {
  recentWorkdirsToProjects,
  sshExistingProjects,
  loadDeviceLinkExistingProjects,
  removeDeviceLinkExistingProject,
} from '@/components/new-chat/remoteExistingProjects';

const sess = (partial: Partial<Session>): Session =>
  ({
    id: 's',
    workspaceKind: 'project',
    workingDir: null,
    remoteHostId: null,
    ...partial,
  }) as unknown as Session;

describe('recentWorkdirsToProjects', () => {
  it('保序映射,basename 唯一时取 basename', () => {
    const out = recentWorkdirsToProjects([
      { path: '/Users/me/projects/alpha', lastUsedAt: '2026-06-15T00:00:00.000Z' },
      { path: '/Users/me/work/beta', lastUsedAt: '2026-06-14T00:00:00.000Z' },
    ]);
    expect(out).toEqual([
      { path: '/Users/me/projects/alpha', name: 'alpha' },
      { path: '/Users/me/work/beta', name: 'beta' },
    ]);
  });

  it('同 basename 碰撞时升级到多段名消歧', () => {
    const out = recentWorkdirsToProjects([
      { path: '/a/repo', lastUsedAt: '2026-06-15T00:00:00.000Z' },
      { path: '/b/repo', lastUsedAt: '2026-06-14T00:00:00.000Z' },
    ]);
    expect(out.map((p) => p.name)).toEqual(['a/repo', 'b/repo']);
  });

  it('Windows 反斜杠路径也能正确取名', () => {
    const out = recentWorkdirsToProjects([
      { path: 'C:\\Users\\me\\proj', lastUsedAt: '2026-06-15T00:00:00.000Z' },
    ]);
    expect(out[0]).toEqual({ path: 'C:\\Users\\me\\proj', name: 'proj' });
  });

  it('保留被控端目录存在性,供项目选择器提示已迁移目录', () => {
    const out = recentWorkdirsToProjects([
      {
        path: '/remote/missing',
        lastUsedAt: '2026-06-15T00:00:00.000Z',
        exists: false,
      },
    ]);
    expect(out[0]).toEqual({ path: '/remote/missing', name: 'missing', exists: false });
  });

  it('空列表 → 空数组', () => {
    expect(recentWorkdirsToProjects([])).toEqual([]);
  });
});

describe('sshExistingProjects', () => {
  it('只取该 host 的 project 会话,workingDir 去重', () => {
    const sessions = [
      sess({ remoteHostId: 'h1', workingDir: '/srv/app' }),
      sess({ remoteHostId: 'h1', workingDir: '/srv/app' }), // 重复目录 → 去重
      sess({ remoteHostId: 'h1', workingDir: '/srv/api' }),
      sess({ remoteHostId: 'h2', workingDir: '/srv/other' }), // 他 host → 排除
      sess({ remoteHostId: null, workingDir: '/local/x' }), // 本地 → 排除
      sess({ remoteHostId: 'h1', workspaceKind: 'dialogue', workingDir: '/srv/chat' }), // 非 project → 排除
      sess({ remoteHostId: 'h1', workingDir: null }), // 空目录 → 排除
      sess({ remoteHostId: 'h1', workingDir: '   ' }), // 空白目录 → 排除
    ];
    const out = sshExistingProjects(sessions, 'h1');
    expect(out).toEqual([
      { path: '/srv/app', name: 'app' },
      { path: '/srv/api', name: 'api' },
    ]);
  });

  it('device-link 会话(无 remoteHostId)不混入 SSH 列表', () => {
    const sessions = [
      sess({ remoteHostId: null, deviceLinkDeviceId: 'dev-1', workingDir: '/dl/proj' }),
    ];
    expect(sshExistingProjects(sessions, 'h1')).toEqual([]);
  });

  it('无匹配 → 空数组', () => {
    expect(sshExistingProjects([], 'h1')).toEqual([]);
  });
});

describe('loadDeviceLinkExistingProjects', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('命中 channel local-db:recent-workdirs:list + 空 args + 正确 deviceId,并映射 rows', async () => {
    invoke.mockResolvedValue([
      { path: '/remote/app', lastUsedAt: '2026-06-15T00:00:00.000Z' },
      { path: '/remote/lib', lastUsedAt: '2026-06-14T00:00:00.000Z' },
    ]);
    const out = await loadDeviceLinkExistingProjects('dev-1');
    expect(invoke).toHaveBeenCalledWith('dev-1', 'local-db:recent-workdirs:list', []);
    expect(out).toEqual([
      { path: '/remote/app', name: 'app' },
      { path: '/remote/lib', name: 'lib' },
    ]);
  });

  it('被控端返回 null/undefined → 空数组(不抛)', async () => {
    invoke.mockResolvedValue(null);
    expect(await loadDeviceLinkExistingProjects('dev-1')).toEqual([]);
  });

  it('从被控端最近项目列表移除路径,不调用本机 recent-workdirs API', async () => {
    invoke.mockResolvedValue({ deleted: true });
    await removeDeviceLinkExistingProject('dev-1', '/remote/app');
    expect(invoke).toHaveBeenCalledWith(
      'dev-1',
      'local-db:recent-workdirs:remove',
      [{ path: '/remote/app' }],
    );
  });
});
