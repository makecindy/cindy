/**
 * ghostUnreadProjection.test.ts — 未读"该不该显示 / 该不该清"的判据。
 * 覆盖:资格审(notify 槽 + badge 声明)、停用只停投影不删记录、能力撤销要清、
 * 以及空清单不误清(启动早期 / 账号切换窗口的 manager 空表)。
 */

import { describe, expect, it } from 'vitest';

import {
  ghostDeclaresBadge,
  isGhostUnreadProjectable,
  selectRevokedGhostUnreadIds,
} from '../ghostUnreadProjection';
import type { InstalledGhost } from '../../../shared/ghost';

function ghost(
  id: string,
  opts: { enabled?: boolean; notify?: boolean; badge?: boolean } = {},
): InstalledGhost {
  const badge = opts.badge ?? true;
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      panel: { html: 'panel.html' },
      ...(opts.notify === false ? {} : { notify: true }),
      ...(badge ? { badge: true } : {}),

    },
    dir: `/fake/${id}`,
    enabled: opts.enabled ?? true,
  } as InstalledGhost;
}

describe('ghostUnreadProjection', () => {
  it('资格只看 badge 卡槽:与 notify 槽无关,也与启用与否无关', () => {
    expect(ghostDeclaresBadge(ghost('a'))).toBe(true);
    expect(ghostDeclaresBadge(ghost('a', { enabled: false }))).toBe(true);
    expect(ghostDeclaresBadge(ghost('a', { badge: false }))).toBe(false);
    // 没有 notify 能力照样算数——绿点与 toast 是并列的两档权限。
    expect(ghostDeclaresBadge(ghost('a', { notify: false }))).toBe(true);
    expect(ghostDeclaresBadge(null)).toBe(false);
  });

  it('投影 = 资格 + 已启用 —— 沉睡的意识不显示点(但记录另说)', () => {
    expect(isGhostUnreadProjectable(ghost('a'))).toBe(true);
    expect(isGhostUnreadProjectable(ghost('a', { enabled: false }))).toBe(false);
    expect(isGhostUnreadProjectable(ghost('a', { badge: false }))).toBe(false);
    expect(isGhostUnreadProjectable(undefined)).toBe(false);
  });

  it('停用**不**进撤销名单:记录保留,唤醒后那颗点要回来', () => {
    const entries = [{ ghostId: 'a' }];
    expect(selectRevokedGhostUnreadIds(entries, [ghost('a', { enabled: false })])).toEqual([]);
  });

  it('能力撤销进撤销名单:更新后不再声明 badge / 包已卸载', () => {
    const entries = [{ ghostId: 'revoked' }, { ghostId: 'noslot' }, { ghostId: 'gone' }, { ghostId: 'ok' }];
    const ids = selectRevokedGhostUnreadIds(entries, [
      ghost('revoked', { badge: false }),
      // 只丢了 notify 但 badge 还在 → **不算**撤销(两档权限彼此独立)。
      ghost('noslot', { notify: false }),
      ghost('ok'),
    ]);
    expect(ids.sort()).toEqual(['gone', 'revoked']);
  });

  it('**非权威**空清单不当成"全都撤销了" —— 启动早期 / 账号切换窗口的空表不许误清', () => {
    expect(selectRevokedGhostUnreadIds([{ ghostId: 'a' }], [])).toEqual([]);
    expect(selectRevokedGhostUnreadIds([], [ghost('a')])).toEqual([]);
  });

  it('**权威**空清单必须清孤儿 —— 否则同 id 重装时旧角标会凭空复活', () => {
    // 卸掉最后一个插件后 manager.list() 就是空表,而且是刚扫完的事实。
    // 不清的话账本里那条永远留着,用户重装同 id 插件时那颗旧点直接亮回来。
    expect(selectRevokedGhostUnreadIds([{ ghostId: 'a' }], [], true)).toEqual(['a']);
    // 权威但非空:照旧只清不再声明能力的那些。
    expect(selectRevokedGhostUnreadIds([{ ghostId: 'a' }, { ghostId: 'b' }], [ghost('b')], true))
      .toEqual(['a']);
  });
});
