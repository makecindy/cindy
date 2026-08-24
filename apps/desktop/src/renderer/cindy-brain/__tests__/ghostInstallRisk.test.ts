import { describe, expect, it } from 'vitest';

import { assessGhostInstallRisk } from '../ghostInstallRisk';
import type { GhostPermissionItem } from '../../../shared/ghost';

/** 只给分档器关心的 key/labelArgs;其余字段占位,分档不看它们。 */
function item(key: string, labelArgs?: Record<string, string>): GhostPermissionItem {
  return { key, kind: 'tool', labelKey: 'tool', ...(labelArgs ? { labelArgs } : {}) };
}

describe('assessGhostInstallRisk · 分档', () => {
  it('skill / node / 凭证 / agent 后台 / agent 派活 都是高危', () => {
    for (const key of [
      'skill:my-skill',
      'node:execute',
      'node:secret:k:main.js:call',
      'network:secret:token',
      'agent:background',
      'agent:errand',
    ]) {
      expect(assessGhostInstallRisk([item(key)]).tier).toBe('high');
    }
  });

  it('oauth 凭证(network:secret: 前缀)判高危', () => {
    // ghostPermissionItems 里 oauth 凭证 key = `network:secret:<key>`。
    expect(assessGhostInstallRisk([item('network:secret:jira')]).tier).toBe('high');
  });

  it('fs / 出网域名 / 自动化 是中危', () => {
    for (const key of ['fs', 'network:host:api.example.com', 'agent:schedule']) {
      expect(assessGhostInstallRisk([item(key)]).tier).toBe('mid');
    }
  });

  it('纯沙箱工具 / 卡片 / 面板 / 聊天指令是低危', () => {
    const low = [item('tool:hello'), item('card'), item('panel'), item('command:foo')];
    expect(assessGhostInstallRisk(low).tier).toBe('low');
  });

  it('高危优先于中危:同时有 fs 与 node 时整体判高危', () => {
    expect(assessGhostInstallRisk([item('fs'), item('node:execute')]).tier).toBe('high');
  });

  it('中危优先于低危:同时有 tool 与 fs 时整体判中危', () => {
    expect(assessGhostInstallRisk([item('tool:x'), item('fs')]).tier).toBe('mid');
  });

  it('命中标记与出网域名如实汇总', () => {
    const assessment = assessGhostInstallRisk([
      item('skill:s'),
      item('network:secret:tok'),
      item('network:host:a.example.com', { host: 'a.example.com' }),
      item('network:host:b.example.com', { host: 'b.example.com' }),
    ]);
    expect(assessment.tier).toBe('high');
    expect(assessment.hazards.skill).toBe(true);
    expect(assessment.hazards.secret).toBe(true);
    expect(assessment.hazards.node).toBe(false);
    expect(assessment.networkHosts).toEqual(['a.example.com', 'b.example.com']);
  });

  it('空清单为低危,无命中,无域名', () => {
    const assessment = assessGhostInstallRisk([]);
    expect(assessment.tier).toBe('low');
    expect(assessment.networkHosts).toEqual([]);
    expect(Object.values(assessment.hazards).every((v) => v === false)).toBe(true);
  });
});
