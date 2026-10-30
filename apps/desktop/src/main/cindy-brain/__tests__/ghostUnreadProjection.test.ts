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
  opts: {
    enabled?: boolean;
    notify?: boolean;
    badge?: boolean;
    namespace?: string | null;
    dir?: string;
  } = {},
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
    dir: opts.dir ?? `/fake/${id}`,
    enabled: opts.enabled ?? true,
    ...(Object.hasOwn(opts, 'namespace') ? { namespace: opts.namespace } : {}),
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

  it.each([true, false])('已迁移的组织插件按物理实例保留未读, enabled=%s', (enabled) => {
    const installed = ghost('helper', {
      enabled, namespace: 'acme', dir: '/fake/_ns/acme/helper',
    });
    expect(selectRevokedGhostUnreadIds([{ ghostId: '_ns__acme__helper' }], [installed], true))
      .toEqual([]);
  });

  it.each([undefined, null, 'acme'])('未搬迁的实例按原物理键保留未读, namespace=%s', (namespace) => {
    const installed = ghost('helper', { namespace });
    expect(selectRevokedGhostUnreadIds([{ ghostId: 'helper' }], [installed], true)).toEqual([]);
  });

  it('同名 root 与组织实例的权限分别撤销,不会互相保留或误删', () => {
    const entries = [{ ghostId: 'helper' }, { ghostId: '_ns__acme__helper' }];
    const root = ghost('helper', { namespace: null });
    const organization = ghost('helper', { namespace: 'acme', dir: '/fake/_ns/acme/helper' });
    expect(selectRevokedGhostUnreadIds(entries, [
      ghost('helper', { namespace: null, badge: false }), organization,
    ], true)).toEqual(['helper']);
    expect(selectRevokedGhostUnreadIds(entries, [
      root, ghost('helper', { namespace: 'acme', dir: '/fake/_ns/acme/helper', badge: false }),
    ], true)).toEqual(['_ns__acme__helper']);
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
