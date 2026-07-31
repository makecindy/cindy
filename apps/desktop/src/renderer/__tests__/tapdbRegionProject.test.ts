// @vitest-environment jsdom

/**
 * tapdbRegionProject.test.ts
 * ---------------------------------------------------------------------------
 * TapDB 项目与构建区域的配对不变量。
 *
 * 背景事故:客户端曾把 cn / global 两个区域都报进国内项目(appId 写死 +
 * 端点写死),国际项目因此没有任何 user_login,服务端按区域上报的充值(charge)
 * 事件全部因 user_id 无效不计入收入统计。
 *
 * 这里把 desktop 侧「appId 与采集端点同区配对」钉成回归测试。配对值需与服务端
 * model-access-server 的 TAPDB_PROJECTS 人工同步维护——本仓测试无法校验服务端
 * 常量,它只保证 desktop 内部不再出现"global 落回国内项目"的回退。
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/vendor/tapdb/tapdb.esm.min.js', () => ({ default: {} }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { subscribeAll: () => () => {}, getRunningSnapshot: () => new Map() },
}));

describe('TAPDB_PROJECT_BY_REGION', () => {
  it('cn 区配对国内项目与国内采集端', async () => {
    const { TAPDB_PROJECT_BY_REGION } = await import('../analytics/tapdbClient');
    expect(TAPDB_PROJECT_BY_REGION.cn).toEqual({
      appId: 'gczef0ey3e8ogpmizs',
      serverUrl: 'https://e.tapdb.com/event',
    });
  });

  it('global 区配对国际项目与国际采集端(不得再落回国内项目)', async () => {
    const { TAPDB_PROJECT_BY_REGION } = await import('../analytics/tapdbClient');
    expect(TAPDB_PROJECT_BY_REGION.global).toEqual({
      appId: 'h08anxdfrvfocfs894',
      serverUrl: 'https://e.tapdb.ap-sg.tapapis.com/event',
    });
    expect(TAPDB_PROJECT_BY_REGION.global.appId).not.toBe(TAPDB_PROJECT_BY_REGION.cn.appId);
    expect(TAPDB_PROJECT_BY_REGION.global.serverUrl).not.toBe(
      TAPDB_PROJECT_BY_REGION.cn.serverUrl,
    );
  });

  it('dev 为内部构建身份,行为语义归 cn 系,复用国内项目', async () => {
    const { TAPDB_PROJECT_BY_REGION } = await import('../analytics/tapdbClient');
    expect(TAPDB_PROJECT_BY_REGION.dev).toEqual(TAPDB_PROJECT_BY_REGION.cn);
  });
});
