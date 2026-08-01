/**
 * collabEntryPolicy 单测:协同入口的**单一判定口径**。
 *
 * 存在的理由(issue #1170):新建草稿与已创建会话曾各自写一份 eligible 判据,于是同一个
 * device-link 项目在草稿里没有协同开关、发出第一条消息进会话页后开关又冒出来。判据分叉
 * 没有任何编译/测试信号,所以这里把五类场景钉死,并另有一条守卫防止两个调用点再各写一份。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveCollabEntryPolicy } from '@/features/cc-agent/collabEntryPolicy';

const R = resolve(__dirname, '..');
// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF。
const read = (rel: string) => readFileSync(resolve(R, rel), 'utf8').replace(/\r\n/g, '\n');

describe('resolveCollabEntryPolicy 五类场景', () => {
  it('本地项目:可挂入口,查本机项目级', () => {
    expect(
      resolveCollabEntryPolicy({ workspaceKind: 'project', workingDir: '/Users/me/proj' }),
    ).toEqual({ eligible: true, skipProjectQuery: false });
  });

  it('SSH 远端项目:可挂入口,但跳过项目级(远端路径在本机查无意义)', () => {
    const scope = resolveCollabEntryPolicy({
      workspaceKind: 'project',
      workingDir: '/home/me/proj',
      remoteHostId: 'host-1',
    });
    expect(scope.eligible).toBe(true);
    expect(scope.skipProjectQuery).toBe(true);
    expect(scope.policyDeviceId).toBeUndefined();
  });

  it('device-link 项目:可挂入口,项目级查询隧道到被控设备', () => {
    const scope = resolveCollabEntryPolicy({
      workspaceKind: 'project',
      workingDir: '/Users/other/proj',
      deviceLinkDeviceId: 'dev-1',
    });
    expect(scope.eligible).toBe(true);
    expect(scope.policyDeviceId).toBe('dev-1');
    // device-link 的项目级配置在被控端**真实存在**,不能跳过 —— 跳过就退化成只看
    // 用户级,项目里单独关掉 collab 的设置会被无视。
    expect(scope.skipProjectQuery).toBe(false);
  });

  it('对话模式(无项目目录):不挂入口', () => {
    // dialogue 会话在 main 侧也会拿到一个自动分配的运行目录,所以必须靠 workspaceKind
    // 判定,不能从 workingDir 反推。
    expect(
      resolveCollabEntryPolicy({
        workspaceKind: 'dialogue',
        workingDir: '/Users/me/Library/.../dialogues/2026-07-31/s1',
      }).eligible,
    ).toBe(false);
    expect(
      resolveCollabEntryPolicy({ workspaceKind: 'project', workingDir: null }).eligible,
    ).toBe(false);
    expect(
      resolveCollabEntryPolicy({ workspaceKind: 'project', workingDir: '   ' }).eligible,
    ).toBe(false);
  });

  it('Orca Worker 子会话:不挂入口(worker 自己不能再开协同)', () => {
    expect(
      resolveCollabEntryPolicy({
        workspaceKind: 'project',
        workingDir: '/Users/me/proj',
        orcaRole: 'worker',
      }).eligible,
    ).toBe(false);
  });

  it('Orca Lead 会话本身仍 eligible(ON 态的 pill 要能渲染成关闭按钮)', () => {
    expect(
      resolveCollabEntryPolicy({
        workspaceKind: 'project',
        workingDir: '/Users/me/proj',
        orcaRole: 'lead',
      }).eligible,
    ).toBe(true);
  });

  it('被控设备上的 SSH 远端项目:两个维度同时成立,不是二选一', () => {
    const scope = resolveCollabEntryPolicy({
      workspaceKind: 'project',
      workingDir: '/home/me/proj',
      remoteHostId: 'host-1',
      deviceLinkDeviceId: 'dev-1',
    });
    // 隧道到被控端执行查询,并在被控端那侧也跳过项目级(路径属于再远一层的 SSH 主机)。
    expect(scope).toEqual({ eligible: true, policyDeviceId: 'dev-1', skipProjectQuery: true });
  });

  it('空串 deviceId / remoteHostId 当作没有(不产生 policyDeviceId 与 skip)', () => {
    expect(
      resolveCollabEntryPolicy({
        workspaceKind: 'project',
        workingDir: '/Users/me/proj',
        deviceLinkDeviceId: '',
        remoteHostId: '',
      }),
    ).toEqual({ eligible: true, skipProjectQuery: false });
  });
});

describe('drift 守卫:两个入口共用同一份判定', () => {
  it('草稿路由与会话视图都调 resolveCollabEntryPolicy,不再各自内联判据', () => {
    for (const f of [
      'features/cc-agent/NewMakerDraftRoute.tsx',
      'features/cc-agent/CCAgentSessionView.tsx',
    ]) {
      const src = read(f);
      expect(src, f).toContain('resolveCollabEntryPolicy({');
      expect(src, f).toContain('collabEntry.eligible');
      // 内联判据的两个历史形态:草稿的 `effectiveDeviceLinkDeviceId == null`(把
      // device-link 整个排除掉)与会话页的 `orcaRole !== 'worker'` 链。
      expect(src, f).not.toContain('effectiveDeviceLinkDeviceId == null');
      expect(src, f).not.toContain("orcaRole !== 'worker'");
    }
  });

  it('两个入口的项目级查询都按 collabEntry 的归属传参(不再写死本机)', () => {
    for (const f of [
      'features/cc-agent/NewMakerDraftRoute.tsx',
      'features/cc-agent/CCAgentSessionView.tsx',
    ]) {
      const src = read(f);
      expect(src, f).toContain('skipQuery: collabEntry.skipProjectQuery');
      expect(src, f).toContain('deviceId: collabEntry.policyDeviceId ?? null');
    }
  });
});
