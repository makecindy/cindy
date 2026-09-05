/**
 * 草稿态首次 create 携带 providerId 回归:main 侧 `local-db:sessions:create` 经由
 * sessionCreateToRow 入库,sessions.provider_id 必须收敛成 "trim 后非空字符串 | null"。
 *
 * 背景:per-session 来源路由原本只在「会话内切来源」(update + maker.setModel)接通,
 * 草稿态首次 create 从不串 providerId,新会话一律以 provider_id=null 出生 → 回落 agent
 * 原生默认来源(cc→XD 网关),用户在草稿里选的「Anthropic 订阅」在发送后被默认顶掉。
 * 这里把「create 落盘显式来源 + 空值落 null(no-break,跟随默认路由)」钉死成回归。
 */

import { describe, it, expect } from 'vitest';

import { sessionCreateToRow } from '../mapper';

describe('sessionCreateToRow providerId', () => {
  const now = 1_700_000_000_000;

  it('显式来源透传并 trim', () => {
    const row = sessionCreateToRow('id1', { workingDir: '/repo', providerId: 'anthropic' }, now);
    expect(row.providerId).toBe('anthropic');
    const trimmed = sessionCreateToRow('id1b', { workingDir: '/repo', providerId: '  anthropic ' }, now);
    expect(trimmed.providerId).toBe('anthropic');
  });

  it('未传 providerId 落 null(跟随默认路由,no-break)', () => {
    const row = sessionCreateToRow('id2', { workingDir: '/repo' }, now);
    expect(row.providerId).toBeNull();
  });

  it('null / 空串 / 纯空白 → null(绝不把默认具体化成某个来源 id)', () => {
    expect(sessionCreateToRow('id3', { workingDir: '/repo', providerId: null }, now).providerId).toBeNull();
    expect(sessionCreateToRow('id4', { workingDir: '/repo', providerId: '' }, now).providerId).toBeNull();
    expect(sessionCreateToRow('id5', { workingDir: '/repo', providerId: '   ' }, now).providerId).toBeNull();
  });
});

describe('sessionCreateToRow source', () => {
  const now = 1_700_000_000_000;

  it('Bot canonical Session 使用 bot 来源', () => {
    const row = sessionCreateToRow(
      'bot-session',
      { workingDir: '/repo', source: 'bot', workspaceKind: 'dialogue' },
      now,
    );
    expect(row.source).toBe('bot');
    expect(row.workspaceKind).toBe('dialogue');
  });

  it('未传 source 仍保持 desktop 兼容默认值', () => {
    expect(sessionCreateToRow('desktop-session', { workingDir: '/repo' }, now).source).toBe('desktop');
  });
});
